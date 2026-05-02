import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Root, RootContent, Definition, FootnoteDefinition } from 'mdast';

export interface Block {
  node: RootContent;
  startOffset: number;
  endOffset: number;
  raw: string;
  id: string;
}

export interface ParsedDoc {
  blocks: Block[];
  definitions: Map<string, Definition>;
  footnotes: Map<string, FootnoteDefinition>;
}

function toBlock(node: RootContent, content: string): Block {
  const startOffset = node.position?.start.offset ?? 0;
  const endOffset = node.position?.end.offset ?? content.length;
  return {
    node,
    startOffset,
    endOffset,
    raw: content.slice(startOffset, endOffset),
    id: `${node.type}-${startOffset}`,
  };
}

export function parseDoc(content: string): ParsedDoc {
  if (!content) return { blocks: [], definitions: new Map(), footnotes: new Map() };

  const tree: Root = fromMarkdown(content, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  const definitions = new Map<string, Definition>();
  const footnotes = new Map<string, FootnoteDefinition>();
  const blocks: Block[] = [];

  for (const node of tree.children) {
    if (node.type === 'definition') {
      definitions.set(node.identifier, node as Definition);
    } else if (node.type === 'footnoteDefinition') {
      footnotes.set(node.identifier, node as FootnoteDefinition);
    } else {
      blocks.push(toBlock(node, content));
    }
  }

  return { blocks, definitions, footnotes };
}
