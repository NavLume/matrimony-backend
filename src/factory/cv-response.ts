import type { CvInfo, CvState } from '../bo/cv.js';

const infoOf = (cv: CvInfo) => ({
  id: cv.id,
  fileName: cv.fileName,
  byteSize: cv.byteSize,
  uploadedAt: cv.uploadedAt,
  uploadedByStaff: cv.uploadedByStaff,
});

/** A profile's CVs as the API returns them. Storage keys and files never appear here. */
export const cvStateResponse = (state: CvState) => ({
  current: state.current && infoOf(state.current),
  replacement: state.replacement && {
    ...infoOf(state.replacement),
    state: state.replacement.state,
    reviewerNotes: state.replacement.reviewerNotes,
  },
});

/** A connected person's CV: only whether there is one and how big it is. */
export const cvInfoResponse = (cv: CvInfo | null) => ({ cv: cv && infoOf(cv) });
