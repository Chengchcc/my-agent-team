import { z } from 'zod'
import { makeToolSchema } from './_factory'

const ASK_HEADER_MAX_CHARS = 12
const ASK_MAX_OPTIONS = 4
const ASK_MAX_QUESTIONS = 4

const askUserQuestionOptionSchema = z.object({
  label: z.string().describe('Short display label for this choice (1–5 words).'),
  description: z.string().describe('What this choice means or implies.'),
  preview: z.string().optional().describe('Optional markdown preview when this option is focused (single-select only).'),
})

const askUserQuestionItemSchema = z.object({
  question: z.string().describe('Full question text; be specific and end with a question mark where appropriate.'),
  header: z.string().max(ASK_HEADER_MAX_CHARS).describe(`Very short tab/tag label (max ${ASK_HEADER_MAX_CHARS} characters), e.g. Auth, Library.`),
  options: z.array(askUserQuestionOptionSchema).min(2).max(ASK_MAX_OPTIONS).describe(`2–${ASK_MAX_OPTIONS} distinct choices; mutually exclusive unless multi_select is true.`),
  multi_select: z.boolean().describe('If true, the user may pick multiple options; if false, exactly one.'),
})

const schema = z.object({
  questions: z.array(askUserQuestionItemSchema).min(1).max(ASK_MAX_QUESTIONS).describe(`1–${ASK_MAX_QUESTIONS} parallel, independent questions (no dependency between them).`),
})

export type AskUserQuestionArgs = z.infer<typeof schema>
export const askUserQuestionToolSchema = makeToolSchema(schema)
