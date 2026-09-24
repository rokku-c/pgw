export interface ServerEvent {
  event: string;
  data: string;
  id: string | null;
  retry: number | null;
}
export class EventStreamParser {
  private decoder = new TextDecoder();
  private line = "";
  private data: string[] = [];
  private event = "";
  private id: string | null = null;
  private retry: number | null = null;
  private skipLF = false;
  private length = 0;
  private ended = false;
  constructor(
    private emit: (event: ServerEvent) => void,
    private limit = 4 * 1024 * 1024,
  ) {}
  push(chunk: Uint8Array) {
    if (this.ended) throw new Error("stream_parser_closed");
    this.consume(this.decoder.decode(chunk, { stream: true }));
  }
  finish() {
    this.consume(this.decoder.decode());
    this.ended = true;
    return (
      this.data.length > 0 ||
      this.line === "data" ||
      this.line.startsWith("data:")
    );
  }
  private consume(text: string) {
    for (const character of text) {
      if (this.skipLF) {
        this.skipLF = false;
        if (character === "\n") continue;
      }
      if (character === "\r" || character === "\n") {
        this.accept(this.line);
        this.line = "";
        if (character === "\r") this.skipLF = true;
      } else {
        this.line += character;
        if (this.line.length + this.length > this.limit)
          throw new Error("upstream_event_too_large");
      }
    }
  }
  private accept(line: string) {
    if (!line) {
      if (this.data.length)
        this.emit({
          event: this.event || "message",
          data: this.data.join("\n"),
          id: this.id,
          retry: this.retry,
        });
      this.data = [];
      this.event = "";
      this.length = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.data.push(value);
      this.length += value.length + 1;
    } else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    else if (
      field === "retry" &&
      /^\d+$/.test(value) &&
      Number.isSafeInteger(Number(value))
    )
      this.retry = Number(value);
  }
}
