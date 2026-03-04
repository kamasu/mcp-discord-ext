import { readFile, stat } from 'fs/promises';
import { basename } from 'path';
import { SendMessageSchema } from '../schemas.js';
import { ToolHandler } from './types.js';
import { handleDiscordError } from "../errorHandler.js";
import { AttachmentBuilder } from 'discord.js';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB (Discord default limit)

interface FileAttachment {
  source: "path" | "url" | "base64";
  value: string;
  name?: string;
  description?: string;
}

async function resolveFileAttachment(file: FileAttachment): Promise<AttachmentBuilder> {
  switch (file.source) {
    case "path": {
      // Validate file exists and check size
      try {
        const fileStat = await stat(file.value);
        if (fileStat.size > MAX_FILE_SIZE) {
          throw new Error(`File ${file.value} exceeds Discord's 25MB limit (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`);
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          throw new Error(`File not found: ${file.value}`);
        }
        throw err;
      }

      const fileName = file.name || basename(file.value);
      const attachment = new AttachmentBuilder(file.value, { name: fileName });
      if (file.description) {
        attachment.setDescription(file.description);
      }
      return attachment;
    }

    case "url": {
      // Validate URL format
      try {
        new URL(file.value);
      } catch {
        throw new Error(`Invalid URL: ${file.value}`);
      }

      const fileName = file.name || basename(new URL(file.value).pathname) || 'attachment';
      const attachment = new AttachmentBuilder(file.value, { name: fileName });
      if (file.description) {
        attachment.setDescription(file.description);
      }
      return attachment;
    }

    case "base64": {
      if (!file.name) {
        throw new Error("'name' is required for base64 file attachments");
      }

      const buffer = Buffer.from(file.value, 'base64');
      if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(`File ${file.name} exceeds Discord's 25MB limit (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
      }

      const attachment = new AttachmentBuilder(buffer, { name: file.name });
      if (file.description) {
        attachment.setDescription(file.description);
      }
      return attachment;
    }

    default:
      throw new Error(`Unknown file source type: ${(file as any).source}`);
  }
}

export const sendMessageHandler: ToolHandler = async (args, { client }) => {
  const { channelId, message, replyToMessageId, files } = SendMessageSchema.parse(args);

  // Validate that at least message or files is provided
  if (!message && (!files || files.length === 0)) {
    return {
      content: [{ type: "text", text: "Either 'message' or 'files' (or both) must be provided." }],
      isError: true
    };
  }

  try {
    if (!client.isReady()) {
      return {
        content: [{ type: "text", text: "Discord client not logged in." }],
        isError: true
      };
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return {
        content: [{ type: "text", text: `Cannot find text channel ID: ${channelId}` }],
        isError: true
      };
    }

    // Ensure channel is text-based and can send messages
    if ('send' in channel) {
      // Build message options
      const messageOptions: any = {};

      // If replyToMessageId is provided, verify the message exists and add reply option
      if (replyToMessageId) {
        if ('messages' in channel) {
          try {
            // Verify the message exists
            await channel.messages.fetch(replyToMessageId);
            messageOptions.reply = { messageReference: replyToMessageId };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Cannot find message with ID: ${replyToMessageId} in channel ${channelId}` }],
              isError: true
            };
          }
        } else {
          return {
            content: [{ type: "text", text: `This channel type does not support message replies` }],
            isError: true
          };
        }
      }

      // Set the message content
      if (message) {
        messageOptions.content = message;
      }

      // Resolve file attachments
      if (files && files.length > 0) {
        const resolvedFiles: AttachmentBuilder[] = [];
        for (const file of files) {
          try {
            const attachment = await resolveFileAttachment(file);
            resolvedFiles.push(attachment);
          } catch (err: any) {
            return {
              content: [{ type: "text", text: `Failed to process file attachment: ${err.message}` }],
              isError: true
            };
          }
        }
        messageOptions.files = resolvedFiles;
      }

      await channel.send(messageOptions);

      // Build response text
      const parts: string[] = [];
      if (message) parts.push("Message");
      if (files && files.length > 0) parts.push(`${files.length} file(s)`);
      const what = parts.join(" and ");

      let responseText = `${what} successfully sent to channel ID: ${channelId}`;
      if (replyToMessageId) {
        responseText += ` as a reply to message ID: ${replyToMessageId}`;
      }

      return {
        content: [{ type: "text", text: responseText }]
      };
    } else {
      return {
        content: [{ type: "text", text: `This channel type does not support sending messages` }],
        isError: true
      };
    }
  } catch (error) {
    return handleDiscordError(error);
  }
};