import type * as Lark from '@larksuiteoapi/node-sdk';
import type { DataPlaneEvent } from '../../../application/contracts';
import { initialState, reduce, markInterrupted, finalizeIfRunning, type RunState } from '../vendor/run-state';
import { renderCard } from '../vendor/run-renderer';
import { mapDataPlaneToAgentEvent } from './data-plane-to-agent-event';

export class TurnCardController {
  private state: RunState = initialState;
  private finalized = false;

  private constructor(
    private readonly stream: Lark.CardStreamController,
  ) {}

  static async open(
    channel: Lark.LarkChannel,
    chatId: string,
    replyToMessageId?: string,
  ): Promise<TurnCardController> {
    let resolveCtrl!: (c: Lark.CardStreamController) => void;
    const ctrlPromise = new Promise<Lark.CardStreamController>((r) => { resolveCtrl = r; });

    let releaseProducer!: () => void;
    const producerDone = new Promise<void>((r) => { releaseProducer = r; });

    void channel.stream(
      chatId,
      {
        card: {
          initial: renderCard(initialState),
          producer: async (controller) => {
            resolveCtrl(controller);
            await producerDone;
          },
        },
      },
      replyToMessageId ? { replyTo: replyToMessageId } : undefined,
    ).catch((err) => {
      console.warn('[turn-card] stream rejected:', err);
    });

    const stream = await ctrlPromise;
    const inst = new TurnCardController(stream);
    (inst as unknown as { _release: () => void })._release = releaseProducer;
    return inst;
  }

  async feed(evt: DataPlaneEvent): Promise<void> {
    if (this.finalized) return;
    const agentEvt = mapDataPlaneToAgentEvent(evt);
    if (!agentEvt) return;
    if (agentEvt.type === 'done' || agentEvt.type === 'error') return;
    this.state = reduce(this.state, agentEvt);
    await this.safeUpdate();
  }

  async finalize(
    outcome: 'done' | 'error' | 'interrupted',
    errorMsg?: string,
  ): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (outcome === 'interrupted') {
      this.state = markInterrupted(this.state);
    } else if (outcome === 'error') {
      this.state = { ...this.state, terminal: 'error', errorMsg, footer: null };
    } else {
      this.state = finalizeIfRunning(this.state);
    }
    await this.safeUpdate();
    const release = (this as unknown as { _release?: () => void })._release;
    if (release) release();
  }

  private async safeUpdate(): Promise<void> {
    try {
      await this.stream.update(renderCard(this.state));
    } catch (err) {
      console.warn('[turn-card] update failed:', err);
    }
  }
}
