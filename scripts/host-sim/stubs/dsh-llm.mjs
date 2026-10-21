// 桩：@deepseek-ai/dsh-llm —— 只实现插件用到的那几个导出
export function createUserMessage(init) {
  return { role: 'user', ...init }
}

export function createAssistantMessage(init) {
  return { role: 'assistant', ...init }
}

export function ReasoningEffortId(id) {
  return id
}

export class BlockAssembler {
  constructor() {
    this.text = ''
    this.finish = { kind: 'stop' }
  }

  push(chunk) {
    if (typeof chunk === 'string') {
      this.text += chunk
      return
    }
    if (chunk && typeof chunk.text === 'string') {
      this.text += chunk.text
      return
    }
    if (chunk && Array.isArray(chunk.content)) {
      for (const part of chunk.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') this.text += part.text
      }
    }
  }

  blocks() {
    return [{ type: 'text', text: this.text }]
  }
}
