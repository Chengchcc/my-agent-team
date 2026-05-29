export async function handle(job: { name: string }): Promise<{ greeting: string }> {
  return { greeting: `Hello, ${job.name}!` }
}

// Standalone entry (called by BunSpawnJobSpawner)
if (process.env.JOB_MODE === 'spawn' && process.env.JOB_WORKER_ENTRY === '1') {
  const chunks: Buffer[] = []
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
  process.stdin.on('end', async () => {
    const job = JSON.parse(Buffer.concat(chunks).toString().trim().split('\n')[0]!)
    try {
      const result = await handle(job)
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exit(0)
    } catch (e) {
      process.stderr.write(String(e) + '\n')
      process.exit(1)
    }
  })
}
