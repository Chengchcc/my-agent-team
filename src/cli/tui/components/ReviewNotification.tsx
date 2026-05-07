import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { FC } from 'react';
import { useTuiStore } from '../state/store';
import type { ReviewNotification as ReviewNotificationType } from '../state/types';

interface ReviewNotificationProps {
  skillName: string;
  description: string;
}

const ReviewNotification: FC<ReviewNotificationProps> = ({ skillName, description }) => {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">Auto-review completed</Text>
      <Text>Created skill: <Text bold>{skillName}</Text></Text>
      <Text dimColor>{description}</Text>
    </Box>
  );
};

/**
 * Renders all active (non-dismissed) review notifications from the TUI store.
 * Uses useMemo with JSON.stringify to stabilize the selector output and avoid
 * infinite re-render loops from Immer draft identity changes.
 */
function ReviewNotifications(): React.ReactElement | null {
  const notifications = useTuiStore((s) => s.reviewNotifications);

  const depKey = notifications.map((n: ReviewNotificationType) => n.skillName + n.dismissed).join(',');
  const active = useMemo(
    () => notifications.filter((n: ReviewNotificationType) => !n.dismissed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [depKey],
  );

  useInput((input, key) => {
    if (!input) return;
    const currentActive = useTuiStore.getState().reviewNotifications.filter(
      (n: ReviewNotificationType) => !n.dismissed,
    );
    if (currentActive.length === 0) return;
    const first = currentActive[0]!;
    if (input === 'k' && !key.ctrl && !key.meta) {
      useTuiStore.getState().keepReviewSkill(first.skillName);
    } else if (input === 'd' && !key.ctrl && !key.meta) {
      useTuiStore.getState().deleteReviewSkill(first.skillName);
    }
  });

  if (active.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {active.map((n: ReviewNotificationType) => (
        <ReviewNotification
          key={n.skillName}
          skillName={n.skillName}
          description={n.description}
        />
      ))}
    </Box>
  );
}

export { ReviewNotification, ReviewNotifications };
export type { ReviewNotificationProps };
