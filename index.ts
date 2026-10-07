import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { connectForum } from "./forum-client.mjs";
import { parseTelegramCommand, findSessionCommand } from "./commands.mjs";
import { accepts, threadParams, sessionNameFromTopic } from "./forum.mjs";

interface ForumBinding {
	chatId: number;
	messageThreadId: number;
	topicName: string;
}

interface TelegramConfig {
	forumChatId?: number;
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	lastUpdateId?: number;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
}

interface TelegramUser {
	id: number;
	is_bot: boolean;
	username?: string;
}

interface TelegramChat {
	id: number;
	type: string;
}

interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

interface TelegramMedia {
	file_id: string;
	file_name?: string;
	mime_type?: string;
}

interface TelegramSticker {
	file_id: string;
}

interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
}

interface TelegramMessage {
	forum_topic_edited?: { name?: string };
	message_thread_id?: number;
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	media_group_id?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramMedia;
	video?: TelegramMedia;
	audio?: TelegramMedia;
	voice?: TelegramMedia;
	animation?: TelegramMedia;
	sticker?: TelegramSticker;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

interface TelegramGetFileResult {
	file_path: string;
}

interface TelegramSentMessage {
	message_id: number;
}

interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

interface PendingTelegramTurn {
	chatId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
	expandPromptTemplates?: boolean;
}

interface QueuedAttachment {
	path: string;
	fileName: string;
}

interface TelegramPreviewState {
	mode: "draft" | "message";
	draftId?: number;
	messageId?: number;
	pendingText: string;
	lastSentText: string;
	flushPromise?: Promise<void>;
	flushTimer?: ReturnType<typeof setTimeout>;
}

interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

const RELOAD_MARKER = "PI_TELEGRAM_PENDING_RELOAD";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.`;

function isTelegramPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function chunkParagraphs(text: string): string[] {
	if (text.length <= MAX_MESSAGE_LENGTH) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const flushCurrent = (): void => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};

	const splitLongBlock = (block: string): string[] => {
		if (block.length <= MAX_MESSAGE_LENGTH) return [block];
		const lines = block.split("\n");
		const lineChunks: string[] = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
				lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
			}
		}
		if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
		return lineChunks;
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) continue;
		const parts = splitLongBlock(paragraph);
		for (const part of parts) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				current = candidate;
			} else {
				flushCurrent();
				current = part;
			}
		}
	}
	flushCurrent();
	return chunks;
}

async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content) as TelegramConfig;
		return parsed;
	} catch {
		return {};
	}
}

async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let forumBinding: ForumBinding | undefined;
	let forumConnection: { close(): void; rename(name: string, force?: boolean): void } | undefined;
	let telegramSessionName: string | undefined;
	let connectionEpoch = 0;
	let pollingController: AbortController | undefined;
	let pollingPromise: Promise<void> | undefined;
	let queuedTelegramTurns: PendingTelegramTurn[] = [];
	let activeTelegramTurn: PendingTelegramTurn | undefined;
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	let typingController: AbortController | undefined;
	let shuttingDown = false;
	let currentAbort: (() => void) | undefined;
	let preserveQueuedTurnsAsHistory = false;
	let setupInProgress = false;
	let previewState: TelegramPreviewState | undefined;
	let draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
	let nextDraftId = 0;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();
	let modelChoices: string[] = [];
	let modelCommandInProgress = false;
	let reloadRequest: { chatId: number; messageThreadId?: number } | undefined;

	function isBusy(ctx: ExtensionContext): boolean {
		return !ctx.isIdle() || !!activeTelegramTurn || queuedTelegramTurns.length > 0 || mediaGroups.size > 0;
	}

	function allocateDraftId(): number {
		nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
		return nextDraftId;
	}

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		if (shuttingDown) return;
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "telegram");
		if (error) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
			return;
		}
		if (!config.botToken) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
			return;
		}
		if (!pollingPromise && !forumConnection) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
			return;
		}
		if (!config.allowedUserId) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
			return;
		}
		if (activeTelegramTurn || queuedTelegramTurns.length > 0) {
			const queued = queuedTelegramTurns.length > 0 ? theme.fg("muted", ` +${queuedTelegramTurns.length} queued`) : "";
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", "processing")}${queued}`);
			return;
		}
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
	}

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown> | FormData,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
			body: body instanceof FormData ? body : JSON.stringify(threadParams(method, body, forumBinding)),
			signal: options?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function callTelegramMultipart(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<void> {
		const form = new FormData();
		for (const [key, value] of Object.entries(threadParams(method, fields, forumBinding))) {
			form.set(key, String(value));
		}
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);
		await callTelegram(method, form, options);
	}

	async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
		await mkdir(TEMP_DIR, { recursive: true });
		const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
		const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
		if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		await writeFile(targetPath, Buffer.from(arrayBuffer));
		return targetPath;
	}

	function startTypingLoop(ctx: ExtensionContext, chatId?: number): void {
		const targetChatId = chatId ?? activeTelegramTurn?.chatId;
		if (shuttingDown || typingInterval || targetChatId === undefined) return;
		const controller = new AbortController();
		typingController = controller;

		const sendTyping = async (): Promise<void> => {
			try {
				await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" }, { signal: controller.signal });
			} catch (error) {
				if (controller.signal.aborted || shuttingDown) return;
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, `typing failed: ${message}`);
			}
		};

		void sendTyping();
		typingInterval = setInterval(() => {
			void sendTyping();
		}, 4000);
	}

	function stopTypingLoop(): void {
		typingController?.abort();
		typingController = undefined;
		if (!typingInterval) return;
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	function isAssistantMessage(message: AgentMessage): boolean {
		return (message as unknown as { role?: string }).role === "assistant";
	}

	function getMessageText(message: AgentMessage): string {
		const value = message as unknown as Record<string, unknown>;
		const content = Array.isArray(value.content) ? value.content : [];
		return content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("")
			.trim();
	}

	async function clearPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		if (state.flushTimer) {
			clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
		}
		previewState = undefined;
		// Let an in-flight request finish before clearing its draft or replacing it.
		await state.flushPromise?.catch(() => undefined);
		if (state.mode === "draft" && state.draftId !== undefined) {
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: "" });
			} catch {
				// ignore
			}
		}
	}

	async function flushPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		if (state.flushTimer) clearTimeout(state.flushTimer);
		state.flushTimer = undefined;
		// Timer and final delivery can flush concurrently. Serialize per preview;
		// read pendingText only after the preceding request updates lastSentText.
		const task = (state.flushPromise ?? Promise.resolve()).catch(() => undefined).then(async () => {
			if (previewState !== state) return;
			await flushPreviewState(chatId, state);
		});
		state.flushPromise = task;
		await task;
	}

	async function flushPreviewState(chatId: number, state: TelegramPreviewState): Promise<void> {
		const truncated = state.pendingText.trim().slice(0, MAX_MESSAGE_LENGTH);
		if (!truncated || truncated === state.lastSentText) return;

		if (draftSupport !== "unsupported") {
			const draftId = state.draftId ?? allocateDraftId();
			state.draftId = draftId;
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated });
				draftSupport = "supported";
				state.mode = "draft";
				state.lastSentText = truncated;
				return;
			} catch {
				draftSupport = "unsupported";
			}
		}

		if (state.messageId === undefined) {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated });
			state.messageId = sent.message_id;
			state.mode = "message";
			state.lastSentText = truncated;
			return;
		}
		try {
			await callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated });
		} catch (error) {
			// Telegram's idempotent edit rejection means delivery already succeeded.
			// Do not suppress other failures (permissions, networking, missing message).
			if (!(error instanceof Error) || !/^Bad Request: message is not modified\b/i.test(error.message)) throw error;
		}
		state.mode = "message";
		state.lastSentText = truncated;
	}

	function schedulePreviewFlush(chatId: number): void {
		if (!previewState || previewState.flushTimer) return;
		const state = previewState;
		state.flushTimer = setTimeout(() => {
			if (previewState !== state) return;
			void flushPreview(chatId).catch(() => { /* Final delivery reports Telegram errors. */ });
		}, PREVIEW_THROTTLE_MS);
	}

	async function finalizePreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		await flushPreview(chatId);
		const finalText = (state.pendingText.trim() || state.lastSentText).trim();
		if (!finalText) {
			await clearPreview(chatId);
		} else if (state.mode === "draft") {
			await callTelegram("sendMessage", { chat_id: chatId, text: finalText });
			await clearPreview(chatId);
		} else {
			previewState = undefined;
		}
	}

	async function sendTextReply(chatId: number, text: string, messageThreadId?: number): Promise<void> {
		for (const chunk of chunkParagraphs(text)) {
			await callTelegram("sendMessage", { chat_id: chatId, text: chunk,
				...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}) });
		}
	}

	async function sendQueuedAttachments(turn: PendingTelegramTurn): Promise<void> {
		for (const attachment of turn.queuedAttachments) {
			try {
				const mediaType = guessMediaType(attachment.path);
				const method = mediaType ? "sendPhoto" : "sendDocument";
				const fieldName = mediaType ? "photo" : "document";
				await callTelegramMultipart(
					method,
					{
						chat_id: String(turn.chatId),
					},
					fieldName,
					attachment.path,
					attachment.fileName,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await sendTextReply(turn.chatId, `Failed to send attachment ${attachment.fileName}: ${message}`);
			}
		}
	}

	function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as unknown as Record<string, unknown>;
			if (message.role !== "assistant") continue;
			const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
			const text = getMessageText(messages[i]);
			return { text: text || undefined, stopReason, errorMessage };
		}
		return {};
	}

	function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
		const files: TelegramFileInfo[] = [];
		const mediaTypes = {
			document: "", video: ".mp4", audio: ".mp3", voice: ".ogg", animation: ".mp4",
		} as const;
		for (const message of messages) {
			if (Array.isArray(message.photo) && message.photo.length > 0) {
				const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
				if (photo) {
					files.push({
						file_id: photo.file_id,
						fileName: `photo-${message.message_id}.jpg`,
						mimeType: "image/jpeg",
						isImage: true,
					});
				}
			}
			for (const kind of Object.keys(mediaTypes) as Array<keyof typeof mediaTypes>) {
				const media = message[kind];
				if (!media) continue;
				const extension = guessExtensionFromMime(media.mime_type, mediaTypes[kind]);
				files.push({
					file_id: media.file_id,
					fileName: media.file_name || `${kind}-${message.message_id}${extension}`,
					mimeType: media.mime_type,
					isImage: kind === "document" && (media.mime_type?.toLowerCase().startsWith("image/") ?? false),
				});
			}
			if (message.sticker) {
				files.push({
					file_id: message.sticker.file_id,
					fileName: `sticker-${message.message_id}.webp`,
					mimeType: "image/webp",
					isImage: true,
				});
			}
		}
		return files;
	}

	async function buildTelegramFiles(messages: TelegramMessage[]): Promise<DownloadedTelegramFile[]> {
		const downloaded: DownloadedTelegramFile[] = [];
		for (const file of collectTelegramFileInfos(messages)) {
			const path = await downloadTelegramFile(file.file_id, file.fileName);
			downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
		}
		return downloaded;
	}

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || setupInProgress) return;
		if (pollingPromise || forumConnection || isBusy(ctx)) {
			ctx.ui.notify("Disconnect Telegram and wait for Pi to become idle before setup.", "warning");
			return;
		}
		setupInProgress = true;
		try {
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token) return;

			const nextConfig: TelegramConfig = { ...config, botToken: token.trim() };
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
				return;
			}

			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			config = nextConfig;
			await writeConfig(config);
			ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
			await startPolling(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
	}

	async function stopPolling(): Promise<void> {
		connectionEpoch++;
		modelChoices = [];
		forumConnection?.close();
		forumConnection = undefined;
		forumBinding = undefined;
		stopTypingLoop();
		pollingController?.abort();
		pollingController = undefined;
		await pollingPromise?.catch(() => undefined);
		pollingPromise = undefined;
	}

	function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[]): string {
		let summary = rawText.length > 0 ? rawText : "(no text)";
		if (files.length > 0) {
			summary += `\nAttachments:`;
			for (const file of files) {
				summary += `\n- ${file.path}`;
			}
		}
		return summary;
	}

	async function createTelegramTurn(
		messages: TelegramMessage[],
		historyTurns: PendingTelegramTurn[] = [],
	): Promise<PendingTelegramTurn> {
		const firstMessage = messages[0];
		if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).filter(Boolean).join("\n\n");
		const files = await buildTelegramFiles(messages);
		const content: Array<TextContent | ImageContent> = [];
		let prompt = `${TELEGRAM_PREFIX}`;

		if (historyTurns.length > 0) {
			prompt += `\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
			for (const [index, turn] of historyTurns.entries()) {
				prompt += `\n\n${index + 1}. ${turn.historyText}`;
			}
			prompt += `\n\nCurrent Telegram message:`;
		}

		if (rawText.length > 0) {
			prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
		}
		if (files.length > 0) {
			prompt += `\n\nTelegram attachments were saved locally:`;
			for (const file of files) {
				prompt += `\n- ${file.path}`;
			}
		}
		content.push({ type: "text", text: prompt });

		for (const file of files) {
			if (!file.isImage) continue;
			const mediaType = file.mimeType || guessMediaType(file.path);
			if (!mediaType) continue;
			const buffer = await readFile(file.path);
			content.push({
				type: "image",
				data: buffer.toString("base64"),
				mimeType: mediaType,
			});
		}

		return {
			chatId: firstMessage.chat.id,
			queuedAttachments: [],
			content,
			historyText: formatTelegramHistoryText(rawText, files),
		};
	}

	async function dispatchAuthorizedTelegramMessages(messages: TelegramMessage[], ctx: ExtensionContext): Promise<void> {
		const firstMessage = messages[0];
		if (!firstMessage) return;
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
		const fileInfos = collectTelegramFileInfos(messages);
		// Service events (topic close/reopen, pins, etc.) are not user requests.
		if (!rawText && fileInfos.length === 0) return;
		const command = messages.length === 1 && !fileInfos.length
			? parseTelegramCommand(rawText, config.botUsername) : undefined;
		if (command?.ignored) return;
		const lower = (command?.text ?? rawText).toLowerCase();

		if (lower === "stop" || lower === "/stop") {
			if (currentAbort) {
				if (queuedTelegramTurns.length > 0) {
					preserveQueuedTurnsAsHistory = true;
				}
				currentAbort();
				updateStatus(ctx);
				await sendTextReply(firstMessage.chat.id, "Aborted current turn.");
			} else {
				await sendTextReply(firstMessage.chat.id, "No active turn.");
			}
			return;
		}

		if (command?.name === "reload") {
			if (command.args) {
				await sendTextReply(firstMessage.chat.id, "Usage: /reload");
				return;
			}
			if (isBusy(ctx) || modelCommandInProgress || reloadRequest) {
				await sendTextReply(firstMessage.chat.id, "Cannot reload while Pi is busy. Wait until idle and try again.");
				return;
			}
			reloadRequest = { chatId: firstMessage.chat.id, messageThreadId: firstMessage.message_thread_id };
			// Lifecycle operations require a command context, not the poller's event context.
			try {
				pi.sendUserMessage("/telegram-reload", { expandPromptTemplates: true });
			} catch (error) {
				reloadRequest = undefined;
				await sendTextReply(firstMessage.chat.id, `Reload dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (command?.name === "thinking") {
			const level = command.args.toLowerCase();
			if (!level) {
				await sendTextReply(firstMessage.chat.id, `Current thinking level: ${pi.getThinkingLevel()}.\nUse /thinking ${THINKING_LEVELS.join("|")}. Model capabilities may limit the effective level.`);
				return;
			}
			if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
				await sendTextReply(firstMessage.chat.id, `Invalid thinking level: ${command.args}.\nUse /thinking ${THINKING_LEVELS.join("|")}.`);
				return;
			}
			if (isBusy(ctx) || modelCommandInProgress) {
				await sendTextReply(firstMessage.chat.id, "Cannot change thinking while Pi is busy or a model command is running. Wait until idle and try again.");
				return;
			}
			try {
				pi.setThinkingLevel(level as ThinkingLevel);
				const effective = pi.getThinkingLevel();
				await sendTextReply(firstMessage.chat.id, effective === level
					? `Thinking level set to ${effective}.`
					: `Requested ${level}; thinking level set to ${effective} because of model capabilities.`);
			} catch (error) {
				await sendTextReply(firstMessage.chat.id, `Thinking command failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (command?.name === "models" || command?.name === "model") {
			if (modelCommandInProgress) {
				await sendTextReply(firstMessage.chat.id, "A model command is already running. Try again shortly.");
				return;
			}
			modelCommandInProgress = true;
			try {
				if (command.name === "model" && !command.args) {
					await sendTextReply(firstMessage.chat.id, `Current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}\nUse /models to list models, then /model provider/model-id or /model number.`);
					return;
				}
				if (command.name === "model" && isBusy(ctx)) {
					await sendTextReply(firstMessage.chat.id, "Cannot switch model while Pi is busy. Send /stop first and wait for Pi to become idle.");
					return;
				}
				await ctx.modelRegistry.refresh();
				const models = ctx.modelRegistry.getAvailable();
				if (command.name === "model" && isBusy(ctx)) {
					await sendTextReply(firstMessage.chat.id, "Pi became busy while refreshing models. Try again when idle.");
					return;
				}
				if (command.name === "models") {
					const filter = command.args.toLowerCase();
					modelChoices = models.map(model => `${model.provider}/${model.id}`).filter(id => id.toLowerCase().includes(filter));
					await sendTextReply(firstMessage.chat.id, modelChoices.length
						? `Available models:\n${modelChoices.map((id, i) => `${i + 1}. ${id}`).join("\n")}\n\nSwitch with /model number or /model provider/model-id.`
						: "No available models match. Configure credentials in the Pi terminal.");
					return;
				}
				const selector = /^\d+$/.test(command.args) ? modelChoices[Number(command.args) - 1] : command.args;
				const model = models.find(model => `${model.provider}/${model.id}` === selector);
				if (!model) {
					await sendTextReply(firstMessage.chat.id, "Unknown or unavailable model. Use /models, then /model number or /model provider/model-id.");
					return;
				}
				const changed = await pi.setModel(model);
				await sendTextReply(firstMessage.chat.id, changed ? `Model switched to ${model.provider}/${model.id}.` : "Model switch failed: authentication is not configured.");
			} catch (error) {
				await sendTextReply(firstMessage.chat.id, `Model command failed: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				modelCommandInProgress = false;
			}
			return;
		}

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, "Cannot compact while pi is busy. Send \"stop\" first.");
				return;
			}
			ctx.compact({
				onComplete: () => {
					void sendTextReply(firstMessage.chat.id, "Compaction completed.");
				},
				onError: (error) => {
					const message = error instanceof Error ? error.message : String(error);
					void sendTextReply(firstMessage.chat.id, `Compaction failed: ${message}`);
				},
			});
			await sendTextReply(firstMessage.chat.id, "Compaction started.");
			return;
		}

		if (lower === "/status" || lower === "/session") {
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}

			const usage = ctx.getContextUsage();
			const lines: string[] = [];
			if (lower === "/session") {
				const entries = ctx.sessionManager.getEntries();
				lines.push(`Session: ${pi.getSessionName() || "(unnamed)"}`);
				lines.push(`ID: ${ctx.sessionManager.getSessionId()}`);
				lines.push(`File: ${ctx.sessionManager.getSessionFile() || "(ephemeral)"}`);
				lines.push(`Directory: ${ctx.cwd}`);
				lines.push(`Messages: ${entries.filter(entry => entry.type === "message").length}`);
			}
			if (ctx.model) {
				lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
				lines.push(`Thinking: ${pi.getThinkingLevel()}`);
			}
			const tokenParts: string[] = [];
			if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
			if (tokenParts.length > 0) {
				lines.push(`Usage: ${tokenParts.join(" ")}`);
			}
			const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
			if (totalCost || usingSubscription) {
				lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
			}
			if (usage) {
				const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
				lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
			} else {
				lines.push("Context: unknown");
			}
			if (lines.length === 0) {
				lines.push("No usage data yet.");
			}
			await sendTextReply(firstMessage.chat.id, lines.join("\n"));
			return;
		}

		if (lower === "/help" || lower === "/start") {
			await sendTextReply(
				firstMessage.chat.id,
				`Send me a message and I will forward it to pi. Commands: /status, /session, /compact, /models [filter], /model [number or provider/model-id], /thinking [level], /reload, /stop. Registered Pi commands, skills, and prompt templates are discovered automatically. Terminal-only built-ins are not remotely dispatchable; interactive command dialogs and errors appear in the Pi terminal.`,
			);
			if (config.allowedUserId === undefined && firstMessage.from) {
				config.allowedUserId = firstMessage.from.id;
				await writeConfig(config);
				updateStatus(ctx);
			}
			return;
		}

		let sessionCommand: ReturnType<typeof findSessionCommand>;
		if (command) {
			sessionCommand = findSessionCommand(pi, command.name);
			if (!sessionCommand) {
				await sendTextReply(firstMessage.chat.id, `Unknown or terminal-only command: /${command.name}. Not sent to the AI.`);
				return;
			}
			if (isBusy(ctx)) {
				await sendTextReply(firstMessage.chat.id, "Cannot execute a command while Pi is busy. Send /stop first and wait for Pi to become idle.");
				return;
			}
			if (sessionCommand.source === "extension") {
				// Dispatch can synchronously disconnect or replace the session. Reply
				// to the originating topic, not whatever binding remains afterward.
				const { id: chatId } = firstMessage.chat;
				const messageThreadId = firstMessage.message_thread_id;
				try {
					pi.sendUserMessage(command.text, { expandPromptTemplates: true });
					await sendTextReply(chatId, `Dispatched ${command.text.split(" ")[0]} to Pi. Command output, dialogs, and execution errors appear in the Pi terminal.`, messageThreadId);
				} catch (error) {
					await sendTextReply(chatId, `Command failed: ${error instanceof Error ? error.message : String(error)}`, messageThreadId);
				}
				return;
			}
		}

		const historyTurns = preserveQueuedTurnsAsHistory ? queuedTelegramTurns.splice(0) : [];
		preserveQueuedTurnsAsHistory = false;
		const epoch = connectionEpoch;
		const turn = await createTelegramTurn(messages, historyTurns);
		if (epoch !== connectionEpoch) return;
		if (command && sessionCommand) {
			turn.content = [{ type: "text", text: command.text }];
			turn.expandPromptTemplates = true;
		}
		queuedTelegramTurns.push(turn);
		if (ctx.isIdle()) {
			startTypingLoop(ctx, turn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(turn.content, { deliverAs: "followUp", ...(turn.expandPromptTemplates ? { expandPromptTemplates: true } : {}) });
		}
	}

	async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.message_thread_id ?? "private"}:${message.media_group_id}`;
			const existing = mediaGroups.get(key) ?? { messages: [] };
			existing.messages.push(message);
			if (existing.flushTimer) clearTimeout(existing.flushTimer);
			existing.flushTimer = setTimeout(() => {
				const state = mediaGroups.get(key);
				mediaGroups.delete(key);
				if (!state) return;
				void dispatchAuthorizedTelegramMessages(state.messages, ctx).catch(error => {
					updateStatus(ctx, error instanceof Error ? error.message : String(error));
				});
			}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
			mediaGroups.set(key, existing);
			return;
		}

		await dispatchAuthorizedTelegramMessages([message], ctx);
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		const message = update.message || update.edited_message;
		if (!message || !message.from || message.from.is_bot) return;
		if (forumBinding) {
			if (!accepts(message, forumBinding, config.allowedUserId)) return;
		} else if (message.chat.type !== "private") return;

		if (config.allowedUserId === undefined) {
			config.allowedUserId = message.from.id;
			await writeConfig(config);
			updateStatus(ctx);
			await sendTextReply(message.chat.id, "Telegram bridge paired with this account.");
		}

		if (message.from.id !== config.allowedUserId) {
			await sendTextReply(message.chat.id, "This bot is not authorized for your account.");
			return;
		}

		if (forumBinding && message.forum_topic_edited) {
			const topicName = message.forum_topic_edited.name;
			// Icon-only edits are service messages too, never agent prompts.
			if (typeof topicName !== "string" || !topicName.trim()) return;
			const name = sessionNameFromTopic(topicName);
			if (pi.getSessionName() !== name) {
				telegramSessionName = name;
				pi.setSessionName(name);
			}
			// Restore the π prefix even if the cached mapping already has this name.
			forumConnection?.rename(name, true);
			ctx.ui.notify(`Session renamed from Telegram: ${name}`, "info");
			return;
		}

		await handleAuthorizedTelegramMessage(message, ctx);
	}

	async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
		if (!config.botToken) return;

		try {
			await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
		} catch {
			// ignore
		}

		if (config.lastUpdateId === undefined) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal });
				const last = updates.at(-1);
				if (last) {
					config.lastUpdateId = last.update_id;
					await writeConfig(config);
				}
			} catch {
				// ignore
			}
		}

		while (!signal.aborted) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
						limit: 10,
						timeout: 30,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal },
				);
				for (const update of updates) {
					config.lastUpdateId = update.update_id;
					await writeConfig(config);
					await handleUpdate(update, ctx);
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, message);
				await new Promise((resolve) => setTimeout(resolve, 3000));
				updateStatus(ctx);
			}
		}
	}

	async function startPolling(ctx: ExtensionContext): Promise<void> {
		if (!config.botToken || pollingPromise || forumConnection) return;
		if (config.forumChatId !== undefined) {
			const epoch = ++connectionEpoch;
			const connection = await connectForum(
				{
					sessionFile: ctx.sessionManager.getSessionFile(),
					sessionId: ctx.sessionManager.getSessionId(),
					name: pi.getSessionName() || basename(ctx.cwd),
				},
				{
					onUpdate: async (update: TelegramUpdate) => {
						if (epoch === connectionEpoch) await handleUpdate(update, ctx);
					},
					onError: (error: string) => {
						if (epoch === connectionEpoch) updateStatus(ctx, error);
					},
					onClose: () => {
						if (epoch !== connectionEpoch) return;
						connectionEpoch++;
						forumConnection = undefined;
						updateStatus(ctx, "dispatcher disconnected; run /telegram-connect again");
					},
				},
			);
			if (epoch !== connectionEpoch) {
				connection.close();
				return;
			}
			forumBinding = connection.binding;
			forumConnection = connection;
			draftSupport = "unsupported";
			ctx.ui.notify(`Telegram topic: ${connection.binding.topicName} (${connection.binding.messageThreadId})`, "info");
			updateStatus(ctx);
			return;
		}
		forumBinding = undefined;
		draftSupport = "unknown";
		pollingController = new AbortController();
		pollingPromise = pollLoop(ctx, pollingController.signal).finally(() => {
			pollingPromise = undefined;
			pollingController = undefined;
			updateStatus(ctx);
		});
		updateStatus(ctx);
	}

	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent with the next Telegram reply.",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
		}),
		async execute(_toolCallId, params) {
			if (!activeTelegramTurn) {
				throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
			}
			const added: string[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) {
					throw new Error(`Not a file: ${inputPath}`);
				}
				if (activeTelegramTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
					throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				}
				activeTelegramTurn.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) });
				added.push(inputPath);
			}
			return {
				content: [{ type: "text", text: `Queued ${added.length} Telegram attachment(s).` }],
				details: { paths: added },
			};
		},
	});

	pi.registerCommand("telegram-reload", {
		description: "Reload Pi and reconnect Telegram (invoked by Telegram /reload)",
		handler: async (_args, ctx) => {
			const request = reloadRequest;
			if (!request) {
				ctx.ui.notify("Use /reload from Telegram, or the built-in /reload in the terminal.", "info");
				return;
			}
			reloadRequest = undefined;
			if (isBusy(ctx) || modelCommandInProgress) {
				await sendTextReply(request.chatId, "Pi became busy before reloading. Try again when idle.");
				return;
			}
			await sendTextReply(request.chatId, "Reloading Pi. Telegram will reconnect automatically.");
			const marker = JSON.stringify({ ...request, sessionId: ctx.sessionManager.getSessionId() });
			// Process-local handoff survives extension replacement, never persisted to disk.
			process.env[RELOAD_MARKER] = marker;
			const token = config.botToken;
			try {
				await ctx.reload();
				// Use only captured plain data: some hosts report reload errors without throwing.
				if (process.env[RELOAD_MARKER] === marker) {
					throw new Error("Pi did not complete extension replacement; check the terminal diagnostics");
				}
			} catch (error) {
				if (process.env[RELOAD_MARKER] === marker) delete process.env[RELOAD_MARKER];
				// Only captured plain data is safe if replacement partially completed.
				await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
					method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ chat_id: request.chatId, message_thread_id: request.messageThreadId,
						text: `Reload failed: ${error instanceof Error ? error.message : String(error)}. Reconnect from the Pi terminal if necessary.` }),
				});
			}
		},
	});

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token",
		handler: async (_args, ctx) => {
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			const status = [
				`bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
				`allowed user: ${config.allowedUserId ?? "not paired"}`,
				`polling: ${forumConnection ? "dispatcher" : pollingPromise ? "running" : "stopped"}`,
				`topic: ${forumBinding ? `${forumBinding.chatId}/${forumBinding.messageThreadId}` : "private"}`,
				`active telegram turn: ${activeTelegramTurn ? "yes" : "no"}`,
				`queued telegram turns: ${queuedTelegramTurns.length}`,
			];
			ctx.ui.notify(status.join(" | "), "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Start the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			if (pollingPromise || forumConnection) {
				ctx.ui.notify("Already connected. Disconnect before changing configuration.", "info");
				return;
			}
			if (isBusy(ctx)) {
				ctx.ui.notify("Wait for Pi to become idle before connecting.", "warning");
				return;
			}
			config = await readConfig();
			if (!config.botToken) {
				await promptForConfig(ctx);
				return;
			}
			await startPolling(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Stop the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			if (isBusy(ctx)) {
				ctx.ui.notify("Wait for Pi to become idle before disconnecting.", "warning");
				return;
			}
			await stopPolling();
			updateStatus(ctx);
		},
	});

	pi.on("session_info_changed", async (event, ctx) => {
		if (telegramSessionName !== undefined && telegramSessionName === event.name) {
			telegramSessionName = undefined;
			return;
		}
		telegramSessionName = undefined;
		forumConnection?.rename(event.name || basename(ctx.cwd));
	});

	pi.on("session_start", async (_event, ctx) => {
		config = await readConfig();
		await mkdir(TEMP_DIR, { recursive: true });
		updateStatus(ctx);
		const marker = process.env[RELOAD_MARKER];
		if (!marker) return;
		delete process.env[RELOAD_MARKER];
		let pending: { sessionId: string; chatId: number; messageThreadId?: number };
		try { pending = JSON.parse(marker); } catch { return; }
		if (pending.sessionId !== ctx.sessionManager.getSessionId()) return;
		try {
			await startPolling(ctx);
			await sendTextReply(pending.chatId, "Pi reloaded. Telegram reconnected.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateStatus(ctx, message);
			await callTelegram("sendMessage", { chat_id: pending.chatId, message_thread_id: pending.messageThreadId,
				text: `Pi reloaded, but Telegram reconnection failed: ${message}. Run /telegram-connect in the Pi terminal.` }).catch(() => undefined);
		}
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		shuttingDown = true;
		stopTypingLoop();
		queuedTelegramTurns = [];
		for (const state of mediaGroups.values()) {
			if (state.flushTimer) clearTimeout(state.flushTimer);
		}
		mediaGroups.clear();
		if (activeTelegramTurn) {
			await clearPreview(activeTelegramTurn.chatId);
		}
		activeTelegramTurn = undefined;
		currentAbort = undefined;
		preserveQueuedTurnsAsHistory = false;
		await stopPolling();
	});

	pi.on("before_agent_start", async (event) => {
		const suffix = (isTelegramPrompt(event.prompt) || !!queuedTelegramTurns[0]?.expandPromptTemplates)
			? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
			: SYSTEM_PROMPT_SUFFIX;
		return {
			systemPrompt: event.systemPrompt + suffix,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentAbort = () => ctx.abort();
		if (!activeTelegramTurn && queuedTelegramTurns.length > 0) {
			const nextTurn = queuedTelegramTurns.shift();
			if (nextTurn) {
				activeTelegramTurn = { ...nextTurn };
				previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
				startTypingLoop(ctx);
			}
		}
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (previewState && (previewState.pendingText.trim().length > 0 || previewState.lastSentText.trim().length > 0)) {
			await finalizePreview(activeTelegramTurn.chatId);
		}
		previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (!previewState) {
			previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
		}
		previewState.pendingText = getMessageText(event.message);
		schedulePreviewFlush(activeTelegramTurn.chatId);
	});

	pi.on("agent_end", async (event, ctx) => {
		const turn = activeTelegramTurn;
		currentAbort = undefined;
		stopTypingLoop();
		activeTelegramTurn = undefined;
		updateStatus(ctx);
		if (!turn) return;

		const assistant = extractAssistantText(event.messages);
		if (assistant.stopReason === "aborted") {
			await clearPreview(turn.chatId);
			return;
		}
		if (assistant.stopReason === "error") {
			await clearPreview(turn.chatId);
			await sendTextReply(turn.chatId, assistant.errorMessage || "Telegram bridge: pi failed while processing the request.");
			return;
		}

		const finalText = assistant.text;
		if (previewState) {
			previewState.pendingText = finalText ?? previewState.pendingText;
		}

		if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
			await finalizePreview(turn.chatId);
		} else {
			await clearPreview(turn.chatId);
			if (finalText) {
				await sendTextReply(turn.chatId, finalText);
			} else if (turn.queuedAttachments.length > 0) {
				await sendTextReply(turn.chatId, "Attached requested file(s).");
			}
		}

		await sendQueuedAttachments(turn);

		if (queuedTelegramTurns.length > 0 && !preserveQueuedTurnsAsHistory) {
			const nextTurn = queuedTelegramTurns[0];
			startTypingLoop(ctx, nextTurn.chatId);
			updateStatus(ctx);
			// agent_end can fire while Pi is still processing the current run.
			pi.sendUserMessage(nextTurn.content, { deliverAs: "followUp", ...(nextTurn.expandPromptTemplates ? { expandPromptTemplates: true } : {}) });
		}
	});
}
