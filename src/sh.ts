/** A project's shell commands: {placeholders} filled in, run with sh in a folder. */

/** {name} → its value; unknown names stay as written */
export const fill = (cmd: string, vars: Record<string, string | number | undefined>) => cmd.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])))
export const tail = (s: string, n = 5) => s.trim().split('\n').slice(-n).join('\n')

export async function sh(cmd: string, cwd: string, env?: Record<string, string | undefined>) {
  const p = Bun.spawn(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', ...(env ? { env } : {}) })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}
