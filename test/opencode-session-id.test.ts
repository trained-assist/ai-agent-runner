import { describe, expect, it } from 'vitest';
import { OPENCODE_SESSION_ID, OPENCODE_CHECKPOINT_PATH } from '../src/contracts/opencode-session-id.js';

describe('OpenCode session identifiers', () => {
  it.each(['ses_eabdad9efffecDKCL3aEAtfJdY', 'ses_01J9A3J9Y7V8W2K4M6N0PQRSTZ'])('accepts native and persisted IDs: %s', (id) => {
    expect(OPENCODE_SESSION_ID.test(id)).toBe(true);
    expect(`.session-traces/${id}.json`.match(OPENCODE_CHECKPOINT_PATH)?.[1]).toBe(id);
  });
  it.each(['ses_../../outside', 'ses_eabdad9efffecDKCL3aEAtfJdY/extra', 'ses_eabdad9efffecDKCL3aEAtfJd', 'ses_eabdad9efffecDKCL3aEAtfJdYx', 'ses_zzzzzzzzzzzzcDKCL3aEAtfJdY', 'msg_eabdad9efffecDKCL3aEAtfJdY'])('rejects malformed IDs without relaxing paths: %s', (id) => {
    expect(OPENCODE_SESSION_ID.test(id)).toBe(false);
    expect(OPENCODE_CHECKPOINT_PATH.test(`.session-traces/${id}.json`)).toBe(false);
  });
});
