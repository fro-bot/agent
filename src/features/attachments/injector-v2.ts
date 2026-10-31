import type {ValidatedAttachment} from './types.js'
import {pathToFileURL} from 'node:url'

/**
 * A file input of the OpenCode V2 prompt (`PromptInput.FileAttachment`, `schema/src/prompt-input.ts`).
 *
 * V2 does not take the V1 SDK's `FilePartInput` (`{type: 'file', mime, url, filename}`): its prompt carries
 * `files: [{uri, name?}]`, and the server reads the `file:` URI itself and detects the mime type from the bytes
 * (`core/src/session/prompt.ts`). A V1 part would be rejected at the schema, so this is the V2 sibling of `toFileParts`.
 * The body rewriting (`modifyBodyForAttachments`) and the download and validation steps are shared and unchanged.
 */
export interface FileAttachmentInputV2 {
  readonly uri: string
  readonly name: string
}

export function toFileAttachmentsV2(attachments: readonly ValidatedAttachment[]): readonly FileAttachmentInputV2[] {
  return attachments.map(attachment => ({
    uri: pathToFileURL(attachment.tempPath).toString(),
    name: attachment.filename,
  }))
}
