export {
  defaultCoverLayout, getCoverBlob, saveCoverVersion, selectCoverVersion,
  saveCoverLayout, saveCoverConnection, saveCoverPreferences, saveCoverAttempt, inspectCoverBlob, MAX_COVER_BYTES, MAX_COVER_VERSIONS,
} from './localStore';
export type { CoverAttempt, CoverLayout, CoverState, CoverStyleId, CoverVersion, CoverVersionInput } from './coverTypes';
