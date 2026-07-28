const reactionSymbols: Record<string, string> = {
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  thumbsdown: "👎",
  laugh: "😄",
  hooray: "🎉",
  tada: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
}

export function issueReactionSymbol(content: string) {
  return reactionSymbols[content] || `:${content}:`
}
