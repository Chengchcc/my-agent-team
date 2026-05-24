import React from 'react';
import { Text } from 'ink';
import type { FinalItem } from '../../state/types';
import { Header } from '../chrome/Header';
import { UserMessageView } from './UserMessageView';
import { AssistantMessageView } from './AssistantMessageView';
import { AssistantHeaderView } from './AssistantHeaderView';
import { CommittedBlockView } from './CommittedBlockView';
import { ToolCallFinalView } from './ToolCallFinalView';
import { AssistantTailView } from './AssistantTailView';
import { DividerView } from './DividerView';
import { SystemNoticeView } from './SystemNoticeView';
import { lookupWidget } from '../../widgets/widget-registry';

interface FinalItemViewProps {
  item: FinalItem;
  toolsExpanded: boolean;
}

export const FinalItemView = React.memo(function FinalItemView({ item, toolsExpanded }: FinalItemViewProps) {
  switch (item.kind) {
    case 'banner':
      return <Header model={item.model} sessionId={item.sessionId} />;
    case 'user-message':
      return <UserMessageView content={item.content} />;
    case 'assistant-message':
      return <AssistantMessageView segments={item.segments} />;
    case 'assistant-header':
      return <AssistantHeaderView />;
    case 'committed-block':
      return <CommittedBlockView raw={item.raw} />;
    case 'tool-call-final':
      return <ToolCallFinalView name={item.name} input={item.input} result={item.result} expanded={toolsExpanded} />;
    case 'assistant-tail':
      return <AssistantTailView raw={item.raw} />;
    case 'divider':
      return <DividerView reason={item.reason} />;
    case 'system-notice':
      return <SystemNoticeView content={item.content} />;
    case 'widget': {
      const w = lookupWidget(item.widget);
      if (!w) return <Text color="red">[unknown widget: {item.widget}]</Text>;
      return <w.Component payload={item.payload as never} />;
    }
    case 'subagent-block': {
      const icon = item.status === 'running' ? '▸' : item.status === 'completed' ? '✓' : item.status === 'failed' ? '✗' : '⊘'
      const elapsed = item.completedAt ? ` ${((item.completedAt - item.startedAt) / 1000).toFixed(1)}s` : ' running…'
      return (
        <Text dimColor={item.status === 'cancelled'}>
          <Text color={item.status === 'running' ? 'yellow' : item.status === 'completed' ? 'green' : 'red'}>
            {icon} sub-agent[{item.type}]
          </Text>
          <Text dimColor>{elapsed}</Text>
          {item.finalText ? <Text dimColor> — {item.finalText.slice(0, 100)}</Text> : null}
        </Text>
      )
    }
  }
});
