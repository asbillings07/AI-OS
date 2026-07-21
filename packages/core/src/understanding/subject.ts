/**
 * The Subject primitive now lives in the neutral `../subject` module so that
 * `domain` can reference it without depending on `understanding` (dependencies
 * point domain -> subject <- understanding, never domain -> understanding).
 *
 * This re-export preserves the historical `understanding/subject.js` import path.
 */
export {
  type SubjectKind,
  type SubjectRef,
  subjectKey,
  checkSubjectId,
} from "../subject/index.js";
