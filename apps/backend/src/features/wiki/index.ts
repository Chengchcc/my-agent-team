export { createFsWikiStore, type WikiStore } from "./adapter-fs.js";
export {
  parsePageText,
  revisionOfText,
  serializePage,
  validatePagePath,
  WIKI_SPACES,
  type WikiFrontmatter,
  type WikiLintFinding,
  type WikiPage,
  type WikiPageStatus,
  type WikiSpace,
} from "./domain.js";
export { wikiRoutes } from "./http.js";
export {
  createWikiService,
  type WikiSearchHit,
  type WikiService,
  type WikiSourceInput,
  type WikiWriteInput,
  type WikiWriteResult,
} from "./service.js";
