export function createEventSmoother(
    write: (chunk: string) => void | Promise<void>,
    { intervalMs = 30, charsPerTick = 4 } = {},
) {
    if (!Number.isInteger(charsPerTick) || charsPerTick < 1) {
        throw new RangeError("charsPerTick must be a positive integer");
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
        throw new RangeError("intervalMs is outside the supported timer range");
    }

    let buffer = "";
    let ended = false;
    let running = false;
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;

    const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });

    async function drain(): Promise<void> {
        if (running) return;
        running = true;

        try {
            while (buffer) {
                await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));

                let end = 0;
                let count = 0;
                for (const char of buffer) {
                    // 保留末尾单独的高代理项，等待下一段补齐 emoji 等字符。
                    if (!ended && end + 1 === buffer.length && /[\uD800-\uDBFF]/.test(char)) {
                        break;
                    }

                    end += char.length;
                    count += 1;
                    if (count === charsPerTick) break;
                }

                if (end === 0) break;

                const chunk = buffer.slice(0, end);
                buffer = buffer.slice(end);
                await write(chunk);
            }

            if (ended) resolveDone();
        } catch (error) {
            ended = true;
            buffer = "";
            rejectDone(error);
        } finally {
            running = false;
        }
    }

    return {
        push(chunk: string) {
            if (ended) throw new Error("The text input is closed");
            if (!chunk) return;

            buffer += chunk;
            void drain();
        },

        end() {
            ended = true;
            void drain();
            return done;
        },

        done,
    };
}