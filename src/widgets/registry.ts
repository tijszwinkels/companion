import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';

import {
  boundedJson,
  object,
  type JsonObject,
  type WidgetBundle,
  type WidgetManifest,
} from './types.ts';

export const libraryDirectory = fileURLToPath(new URL('../../widget-library/', import.meta.url));
const names = /^[a-z][a-z0-9-]{0,47}$/;
const hashes = /^[0-9a-f]{64}$/;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Linux's proc descriptor paths anchor each lookup to an already opened parent.
 * O_NOFOLLOW protects only the final component, so walk every component from /
 * instead of re-resolving a checked path. A concurrent rename cannot retarget an
 * open handle. Keep parents alive until their child opens; close every handle on
 * failure. No authored symlink is followed, including in the library's ancestry.
 */
async function openDirectory(path: string): Promise<FileHandle> {
  const flags = readFlags | constants.O_DIRECTORY;
  let directory = await open('/', flags);
  try {
    for (const component of resolve(path).split('/').filter(Boolean)) {
      const parent = directory;
      directory = await open(`/proc/self/fd/${parent.fd}/${component}`, flags);
      await parent.close();
    }
    return directory;
  } catch (cause) {
    await directory.close();
    throw Error('Widget paths must use directories without symlinks', { cause });
  }
}

async function readAsset(
  directory: FileHandle,
  name: string,
  maxCharacters: number,
): Promise<string> {
  // These names are fixed entry files, never paths supplied by a manifest.
  // Nonblocking open prevents a substituted FIFO from waiting for a writer.
  const file = await open(`/proc/self/fd/${directory.fd}/${name}`, readFlags);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw Error('Widget assets must be regular files');
    }
    const maxBytes = maxCharacters * 4;
    if (metadata.size > maxBytes) {
      throw Error('Widget asset exceeds its size limit');
    }
    // fstat is only an early rejection. Bound the actual read as well, since
    // an author may grow the same inode after the size check. The extra byte
    // distinguishes a full allowed file from an oversized one without readFile.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    const text = buffer.toString('utf8', 0, length);
    if (length > maxBytes || text.length > maxCharacters) {
      throw Error('Widget asset exceeds its size limit');
    }
    return text;
  } finally {
    await file.close();
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Discover metadata only. Widget JavaScript is data here, never imported by Node. */
export class WidgetRegistry {
  private readonly ajv = new Ajv({ allErrors: false, useDefaults: true, strict: true });
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(
    private readonly cache: string,
    private readonly library = libraryDirectory,
  ) {}

  private manifest(value: unknown): WidgetManifest {
    const input = object(value);
    if (
      typeof input.name !== 'string' ||
      !names.test(input.name) ||
      !Number.isSafeInteger(input.version) ||
      Number(input.version) < 1 ||
      typeof input.description !== 'string' ||
      !input.description ||
      input.description.length > 1000
    ) {
      throw Error('Invalid widget manifest');
    }
    const actions = object(input.actions);
    if (Object.keys(actions).length > 20) {
      throw Error('A widget may expose at most 20 actions');
    }
    for (const [name, definition] of Object.entries(actions)) {
      const action = object(definition);
      if (
        !/^[a-z][a-z0-9_]{0,47}$/.test(name) ||
        typeof action.description !== 'string' ||
        action.description.length > 500
      ) {
        throw Error('Invalid widget action');
      }
      this.validateSchema(object(action.parameters));
      this.validateSchema(object(action.returns));
    }
    this.validateSchema(object(input.parameters));
    object(input.example);
    boundedJson(input, 48 * 1024);
    return input as unknown as WidgetManifest;
  }

  private validateSchema(schema: JsonObject): void {
    // Schemas are local descriptions, never resolvers for remote schema URLs.
    // Disallow references altogether in v1 to keep bundles self-contained.
    const allowed = new Set([
      'type',
      'properties',
      'required',
      'additionalProperties',
      'items',
      'minItems',
      'maxItems',
      'minLength',
      'maxLength',
      'minimum',
      'maximum',
      'enum',
      'default',
      'description',
      'title',
    ]);
    const inspect = (value: JsonObject, depth = 0): void => {
      if (depth > 12 || Object.keys(value).some((key) => !allowed.has(key))) {
        throw Error('Widget schema uses unsupported keywords or excessive nesting');
      }
      // No regular expressions, references or combinators from authored
      // manifests run in the listener. This bounded subset avoids expensive
      // schema evaluation; cross-field checks can run in the browser reducer.
      if (value.properties) {
        const fields = Object.values(object(value.properties));
        if (fields.length > 100) {
          throw Error('Too many widget properties');
        }
        for (const field of fields) {
          inspect(object(field), depth + 1);
        }
      }
      if (value.items) {
        inspect(object(value.items), depth + 1);
      }
      if (value.additionalProperties && typeof value.additionalProperties === 'object') {
        inspect(object(value.additionalProperties), depth + 1);
      }
      if (Array.isArray(value.enum) && value.enum.length > 64) {
        throw Error('Too many widget enum values');
      }
    };
    boundedJson(schema, 32 * 1024);
    inspect(schema);
    this.ajv.compile(schema);
    this.ajv.removeSchema(schema);
  }

  validate(schema: JsonObject, value: unknown): JsonObject {
    const data = JSON.parse(boundedJson(object(value)));
    const key = JSON.stringify(schema);
    let validator = this.validators.get(key);
    if (!validator) {
      validator = this.ajv.compile(schema);
      this.ajv.removeSchema(schema);
      if (this.validators.size >= 256) {
        this.validators.clear();
      }
      this.validators.set(key, validator);
    }
    if (!validator(data)) {
      throw Error(this.ajv.errorsText(validator.errors));
    }
    boundedJson(data);
    return data as JsonObject;
  }

  async discover(query = '', name?: string): Promise<unknown> {
    if (name) {
      return (await this.load(name)).manifest;
    }
    const entries = await readdir(this.library, { withFileTypes: true });
    const catalog = [];
    for (const entry of entries.slice(0, 200)) {
      if (!entry.isDirectory() || !names.test(entry.name)) {
        continue;
      }
      try {
        const manifest = (await this.load(entry.name)).manifest;
        if (
          `${manifest.name} ${manifest.description}`.toLowerCase().includes(query.toLowerCase())
        ) {
          catalog.push({
            name: manifest.name,
            description: manifest.description,
            actions: Object.keys(manifest.actions),
          });
        }
      } catch {
        // A half-written widget during development cannot hide working entries.
      }
    }
    return { directory: this.library, widgets: catalog };
  }

  async load(name: string): Promise<WidgetBundle> {
    if (!names.test(name)) {
      throw Error('Unknown widget name');
    }
    const directory = await openDirectory(join(this.library, name));
    try {
      const manifest = this.manifest(
        JSON.parse(await readAsset(directory, 'widget.json', 48 * 1024)),
      );
      if (manifest.name !== name) {
        throw Error('Widget name must match its directory');
      }
      const javascript = await readAsset(directory, 'widget.js', 1024 * 1024);
      const css = await readAsset(directory, 'style.css', 32 * 1024);
      const content = { manifest, javascript, css };
      const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
      return { hash, ...content };
    } finally {
      await directory.close();
    }
  }

  async retain(bundle: WidgetBundle): Promise<void> {
    await mkdir(this.cache, { recursive: true, mode: 0o700 });
    await atomicJson(join(this.cache, bundle.hash + '.json'), bundle);
  }

  async retained(hash: string): Promise<WidgetBundle> {
    if (!hashes.test(hash)) {
      throw Error('Invalid widget bundle hash');
    }
    const bundle = object(JSON.parse(await readFile(join(this.cache, hash + '.json'), 'utf8')));
    const manifest = this.manifest(bundle.manifest);
    if (
      typeof bundle.javascript !== 'string' ||
      bundle.javascript.length > 1024 * 1024 ||
      typeof bundle.css !== 'string' ||
      bundle.css.length > 32 * 1024
    ) {
      throw Error('Invalid widget bundle');
    }
    const content = { manifest, javascript: bundle.javascript, css: bundle.css };
    const actual = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    if (actual !== hash) {
      throw Error('Saved widget bundle failed its integrity check');
    }
    return { hash, ...content };
  }
}
