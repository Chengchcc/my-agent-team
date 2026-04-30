import React from 'react';
import type { FinalItem } from '../../state/types';
import { Header } from '../chrome/Header';
import { UserMessageView } from './UserMessageView';
import { AssistantMessageView } from './AssistantMessageView';
import { DividerView } from './DividerView';

interface FinalItemViewProps {
  item: FinalItem;
}

export const FinalItemView = React.memo(function FinalItemView({ item }: FinalItemViewProps) {
  switch (item.kind) {
    case 'banner':
      return <Header model={item.model} sessionId={item.sessionId} />;
    case 'user-message':
      return <UserMessageView content={item.content} />;
    case 'assistant-message':
      return <AssistantMessageView segments={item.segments} />;
    case 'divider':
      return <DividerView reason={item.reason} />;
  }
});
