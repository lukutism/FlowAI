import { expect, test } from 'bun:test'
import { act, useState } from 'react'
import { useKeyboard } from '@opentui/react'
import { testRender } from '@opentui/react/test-utils'

// OpenTUI 0.5.17 as flow uses it: boxes, coloured text, keys, a captured frame
function App() {
  const [n, setN] = useState(0)
  useKeyboard(k => { if (k.name === 'j') setN(x => x + 1) })
  return (
    <box flexDirection="column">
      <text><span fg="#78A6EC">flow</span> runs</text>
      <text>selected {n}</text>
    </box>
  )
}

test('OpenTUI renders text and reacts to keys', async () => {
  const s = await testRender(<App />, { width: 30, height: 4 })
  try {
    await s.renderOnce()
    expect(s.captureCharFrame()).toContain('flow runs')
    await act(async () => { s.mockInput.pressKey('j') })
    await s.renderOnce()
    expect(s.captureCharFrame()).toContain('selected 1')
  } finally { s.renderer.destroy() }
})
