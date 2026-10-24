import { parseStream, type AgentEvent } from './stream.ts'

/** The agent a run talks to: one turn per message, as a stream of events. */
export interface Agent { turn(prompt: string): AsyncIterable<AgentEvent> }

/** Replays recorded CLI sessions (test/fixtures), one recording per turn, in order. */
export class FakeAgent implements Agent {
  readonly prompts: string[] = []
  constructor(private scripts: string[]) {}
  async *turn(prompt: string): AsyncIterable<AgentEvent> {
    const script = this.scripts[this.prompts.length]
    if (script === undefined) throw new Error(`the fake agent has ${this.scripts.length} recorded turn(s); turn ${this.prompts.length + 1} was asked for`)
    this.prompts.push(prompt)
    yield* parseStream(script)
  }
}
