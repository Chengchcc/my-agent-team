import React from 'react';
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
  }
});
