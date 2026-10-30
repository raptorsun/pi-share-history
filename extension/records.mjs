// Explicit allowlist: never forward raw provider payloads, signatures, system prompts,
// tool-result details, local session paths, or extension state (including owner keys).
function text(value, limit = 24000) {
  const s = String(value ?? '');
  return s.length > limit ? s.slice(0, limit) + '\n[truncated by pi-share-history]' : s;
}
function printable(value) {
  try { return text(JSON.stringify(value, null, 2)); } catch { return '[unserializable]'; }
}
export function content(value) {
  if (typeof value === 'string') return text(value);
  if (!Array.isArray(value)) return '';
  return text(value.map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'toolCall') return `Tool: ${block.name}\n${printable(block.arguments)}`;
    if (block.type === 'image') return '[image omitted]';
    if (block.type === 'thinking') return '[thinking omitted]';
    return `[${block.type || 'unknown'} block omitted]`;
  }).join('\n\n'));
}
export function messageRecord(message) {
  if (!message || message.role === 'system') return null;
  const role = message.role;
  if (!['user', 'assistant', 'toolResult', 'bashExecution', 'custom', 'branchSummary', 'compactionSummary'].includes(role)) return null;
  return {
    id: role === 'toolResult' ? `result:${message.toolCallId}` : `message:${role}:${message.timestamp}`,
    kind: role, timestamp: message.timestamp, model: message.model,
    label: message.toolName || message.customType || role,
    text: role === 'bashExecution' ? text(`$ ${message.command}\n${message.output}`) : content(message.content ?? message.summary),
    error: Boolean(message.isError || message.errorMessage),
    errorMessage: message.errorMessage ? text(message.errorMessage) : undefined,
  };
}
export function toolRecord(event) {
  return {
    id: `tool:${event.toolCallId}`, kind: 'tool', timestamp: Date.now(), label: event.toolName,
    status: event.type === 'tool_execution_end' ? (event.isError ? 'error' : 'done') : 'running',
    text: content(event.result?.content ?? event.partialResult?.content) || (event.args ? printable(event.args) : ''),
    error: Boolean(event.isError), parent: event.parentToolCallId,
  };
}
