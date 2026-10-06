/** @jsxImportSource @opentui/solid */
// OpenCode statusline matching ~/.claude/hooks/statusline.js:
//   dir │ model │ effort │ context: ███░░░░░░░ 30%
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"

const GREEN = "#5fd75f"
const YELLOW = "#d7d75f"
const ORANGE = "#ff8700"
const RED = "#ff5f5f"

function contextColor(used: number) {
  if (used < 50) return GREEN
  if (used < 65) return YELLOW
  if (used < 80) return ORANGE
  return RED
}

function View(props: { api: TuiPluginApi }) {
  const api = props.api
  const theme = () => api.theme.current
  const route = () => api.route.current as { name: string; params?: { sessionID?: string } }
  const sessionID = () => (route().name === "session" ? route().params?.sessionID : undefined)
  const messages = createMemo(() => {
    const id = sessionID()
    return id ? api.state.session.messages(id) : []
  })
  const lastAssistant = createMemo(() =>
    messages().findLast((m): m is AssistantMessage => m.role === "assistant"),
  )
  const lastUser = createMemo(() => messages().findLast((m): m is UserMessage => m.role === "user"))

  const model = createMemo(() => {
    const ref = lastAssistant() ?? lastUser()?.model
    const providerID = ref && ("providerID" in ref ? ref.providerID : undefined)
    const modelID = ref && ("modelID" in ref ? ref.modelID : undefined)
    const configured = api.state.config.model as string | undefined
    const [p, m] = providerID && modelID ? [providerID, modelID] : (configured?.split("/") ?? [])
    const info = api.state.provider.find((x) => x.id === p)?.models[m ?? ""]
    return { name: info?.name ?? m ?? "OpenCode", limit: info?.limit.context ?? 0, info }
  })

  const effort = createMemo(() => {
    const variant = lastUser()?.model?.variant
    if (variant) return variant
    const opts = model().info?.options as Record<string, unknown> | undefined
    return (opts?.reasoningEffort as string | undefined) ?? ""
  })

  const used = createMemo(() => {
    const last = messages().findLast((m): m is AssistantMessage => m.role === "assistant" && m.tokens.output > 0)
    if (!last || !model().limit) return 0
    const t = last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    return Math.max(0, Math.min(100, Math.round((t / model().limit) * 100)))
  })

  const bar = () => {
    const filled = Math.floor(used() / 10)
    return "█".repeat(filled) + "░".repeat(10 - filled)
  }
  const dir = () => (api.state.path.directory || "").split("/").filter(Boolean).pop() ?? "~"
  const sep = () => <span style={{ fg: theme().textMuted }}> │ </span>

  return (
    <box paddingLeft={2} paddingRight={2} flexShrink={0}>
      <text>
        <span style={{ fg: theme().text }}>{dir()}</span>
        {sep()}
        <span style={{ fg: theme().text }}>{model().name}</span>
        {effort() ? sep() : ""}
        {effort() ? <span style={{ fg: theme().textMuted }}>{effort()}</span> : ""}
        {sep()}
        <span style={{ fg: theme().text }}>context: </span>
        <span style={{ fg: contextColor(used()) }}>{`${bar()} ${used()}%`}</span>
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 1000,
    slots: {
      app_bottom() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "local.statusline", tui }
export default plugin
