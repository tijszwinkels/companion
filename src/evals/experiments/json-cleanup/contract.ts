/**
 * The json-cleanup response contract is shared with the live app and lives in
 * src/core/transcription-cleanup/contract.ts (a pure module without imports or
 * I/O). Re-exported here unchanged so the experiment's modules and tests keep
 * one import location.
 */
export * from '../../../core/transcription-cleanup/contract.ts';
