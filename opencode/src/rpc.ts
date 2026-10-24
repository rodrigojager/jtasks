// The RPC the TUI section reads (`jtasks.state`): the display model of the run bound to a session, computed on
// the server, so the TUI never touches the files.

import { Rpc } from "@opencode/plugin/rpc"

export const TasksRpc = Rpc.define({
  id: "jtasks",
  methods: {
    state: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { view: {} },
        required: ["view"],
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { run: { type: "string" } },
        required: ["run"],
        additionalProperties: false,
      },
    },
  },
})
