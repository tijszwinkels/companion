import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
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
    const root = await realpath(this.library);
    const directory = await realpath(join(root, name));
    if (!directory.startsWith(root + sep)) {
      throw Error('Widget paths must remain inside the library');
    }
    const read = async (file: string, max: number): Promise<string> => {
      const path = await realpath(join(directory, file));
      if (!path.startsWith(directory + sep)) {
        throw Error('Widget assets must remain inside their directory');
      }
      if ((await stat(path)).size > max * 4) {
        throw Error('Widget asset exceeds its size limit');
      }
      const text = await readFile(path, 'utf8');
      if (text.length > max) {
        throw Error('Widget asset exceeds its size limit');
      }
      return text;
    };
    const manifest = this.manifest(JSON.parse(await read('widget.json', 48 * 1024)));
    if (manifest.name !== name) {
      throw Error('Widget name must match its directory');
    }
    const javascript = await read('widget.js', 1024 * 1024);
    const css = await read('style.css', 32 * 1024);
    const content = { manifest, javascript, css };
    const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    return { hash, ...content };
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
