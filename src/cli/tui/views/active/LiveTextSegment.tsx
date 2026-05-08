import React, { useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import { useSegmentFrame } from '../../streaming/committer';
import { renderNode, type RenderContext } from '../../markdown/render-ast';
import { useTerminalWidth } from '../../hooks/use-terminal-width';

interface LiveTextSegmentProps {
  segId: string;
}

export function LiveTextSegment({ segId }: LiveTextSegmentProps) {
  const frame = useSegmentFrame(segId);
  const width = useTerminalWidth();

  // Cache rendered committed block elements. Once a block is committed its
  // rendered output never changes, so we store the React element once and
  // reuse it on every frame — React reconciliation skips cached elements.
  const stableCacheRef = useRef<Map<string, React.ReactNode>>(new Map());

  const { stable, tail } = useMemo(() => {
    if (!frame) return { stable: [] as React.ReactNode[], tail: [] as React.ReactNode[] };

    const ctx: RenderContext = {
      terminalWidth: width,
      definitions: frame.definitions,
      footnotes: frame.footnotes,
    };

    const stableNodes: React.ReactNode[] = [];
    for (const block of frame.blocks) {
      if (block.endOffset <= frame.committedLength) {
        let cached = stableCacheRef.current.get(block.id);
        if (!cached) {
          cached = (
            <Box key={block.id}>
              {renderNode(block.node, ctx)}
            </Box>
          );
          stableCacheRef.current.set(block.id, cached);
        }
        stableNodes.push(cached);
      }
    }

    // Tail: render the uncommitted block as plain text (no AST traversal).
    const tailBlock = frame.blocks.find(b => b.endOffset > frame.committedLength);
    const tailNodes: React.ReactNode[] = [];
    if (tailBlock) {
      tailNodes.push(
        <Text key={`tail-${tailBlock.id}`}>{tailBlock.raw.replace(/\n+$/, '')}</Text>,
      );
    } else if (frame.blocks.length === 0 && frame.committedLength < frame.content.length) {
      // No markdown blocks yet — render trailing content as raw text.
      tailNodes.push(
        <Text key="raw-tail">{frame.content.slice(frame.committedLength)}</Text>,
      );
    }

    return { stable: stableNodes, tail: tailNodes };
  }, [frame, width]);

  if (!frame || (stable.length === 0 && tail.length === 0)) {
    return (
      <Box height={1}>
        <Text>{' '}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {stable.length > 0 ? stable : null}
      {tail.length > 0 ? tail : null}
    </Box>
  );
}
