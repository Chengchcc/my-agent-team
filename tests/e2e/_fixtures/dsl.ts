export async function given(_desc: string, fn: () => void | Promise<void>) { await fn() }
export async function when(_desc: string, fn: () => void | Promise<void>) { await fn() }
export async function then(_desc: string, fn: () => void | Promise<void>) { await fn() }
