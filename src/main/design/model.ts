// The one boundary between the design harness and a model provider. The harness owns the loop,
// the tools and the state; a ModelClient only turns a request into the next model message.

export interface FunctionCall {
  id?: string
  name: string
  args?: Record<string, unknown>
}

export interface Part {
  text?: string
  thought?: boolean
  /** Opaque. Returned with the part it came on, within the same turn and model. */
  thoughtSignature?: string
  functionCall?: FunctionCall
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}

export interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

export interface FunctionDeclaration {
  name: string
  description: string
  parametersJsonSchema: Record<string, unknown>
}

export interface ModelRequest {
  model: string
  system: string
  contents: Content[]
  tools: FunctionDeclaration[]
  /** NONE asks for a text answer only, e.g. to explain a proposal after it was recorded. */
  toolMode: 'AUTO' | 'NONE'
  signal: AbortSignal
}

export interface ModelResponse {
  parts: Part[]
  finishReason?: string
}

export interface ModelClient {
  generate(request: ModelRequest): Promise<ModelResponse>
}

interface GenerateContentResponse {
  candidates?: { finishReason?: string; content?: { parts?: Part[] } }[]
  promptFeedback?: { blockReason?: string }
}

/** Standard Gemini API generateContent with client-executed function declarations. */
export function geminiModelClient(
  apiKey: () => string | undefined = () => process.env.GEMINI_API_KEY?.trim()
): ModelClient {
  return {
    async generate({ model, system, contents, tools, toolMode, signal }) {
      const key = apiKey()
      if (!key) throw new Error('GEMINI_API_KEY is missing from the main-process environment.')
      if (!/^[\w.-]+$/.test(model)) throw new Error(`Invalid model ID ${model}.`)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents,
            tools: [{ functionDeclarations: tools }],
            toolConfig: { functionCallingConfig: { mode: toolMode } }
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)])
        })
      } catch (error) {
        if (signal.aborted) throw signal.reason
        throw new Error(`Could not reach the Gemini API for ${model}.`, { cause: error })
      }
      if (!response.ok) throw new Error(`Gemini ${model} returned HTTP ${response.status}.`)
      const body = (await response.json()) as GenerateContentResponse
      const candidate = body.candidates?.[0]
      if (!candidate?.content?.parts?.length) {
        const why = body.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'no content'
        throw new Error(`Gemini ${model} returned no message (${why}).`)
      }
      return { parts: candidate.content.parts, finishReason: candidate.finishReason }
    }
  }
}
