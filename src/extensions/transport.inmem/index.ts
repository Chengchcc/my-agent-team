import { defineExtension } from '../../kernel/define-extension'
import { InMemoryTransport } from '../../infrastructure/transport/inmem-transport'

export default () =>
  defineExtension({
    name: 'transport-inmem',
    enforce: 'post', // After controlplane + dataplane are up
    dependsOn: ['controlplane', 'dataplane'],
    apply: (ctx) => {
      let transport: InMemoryTransport | null = null
      return {
        provide: {
          'transport-inmem.transport': () => transport ??= new InMemoryTransport(ctx),
        },
      }
    },
  })
