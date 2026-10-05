/**
 * Write the synthetic adversarial fixture set for the JSON cleanup experiment
 * into a NEW directory, for dry-runs, reviewer inspection or a later,
 * separately authorized real comparison run:
 *
 *   npx tsx test/fixtures/intent-json-cleanup/generate.ts /tmp/new-fixture-directory
 *
 * Everything is synthetic (see adversarial.ts). No model is called.
 */
import { writeAdversarialFixtures } from './adversarial.ts';

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) {
  console.error('Usage: npx tsx test/fixtures/intent-json-cleanup/generate.ts NEW_DIRECTORY');
  process.exit(2);
}

const paths = await writeAdversarialFixtures(directory);
console.log(JSON.stringify(paths, null, 2));
