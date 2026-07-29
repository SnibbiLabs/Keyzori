import { describe, expect, test } from "bun:test";
import { readBoundedResponseText } from "../upstream";

describe("bounded upstream response reader", () => {
	test("cancels the stream as soon as the byte ceiling is crossed", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.enqueue(new Uint8Array([4, 5, 6]));
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(stream);
		await expect(readBoundedResponseText(response, 4)).rejects.toThrow(
			"exceeded the size limit",
		);
		expect(cancelled).toBe(true);
	});

	test("rejects an oversized declared length without reading the body", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { "content-length": "5" } },
		);
		await expect(readBoundedResponseText(response, 4)).rejects.toThrow(
			"exceeded the size limit",
		);
		expect(cancelled).toBe(true);
	});
});
