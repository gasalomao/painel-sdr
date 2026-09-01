import { describe, expect, it } from "vitest";
import { __pendingLocks, withSessionLock } from "../session-lock";

describe("withSessionLock", () => {
  it("serializa execuções da mesma sessão", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let signalSecondStarted!: () => void;
    const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondHold = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const secondStarted = new Promise<void>((resolve) => { signalSecondStarted = resolve; });

    const first = withSessionLock("session-1", async () => {
      events.push("first:start");
      await firstHold;
      events.push("first:end");
    });
    await Promise.resolve();

    const second = withSessionLock("session-1", async () => {
      events.push("second:start");
      signalSecondStarted();
      await secondHold;
      events.push("second:end");
    });
    await Promise.resolve();
    await Promise.resolve();
    const beforeFirstEnds = [...events];

    releaseFirst();
    await first;
    await secondStarted;
    await Promise.resolve();
    releaseSecond();
    await second;

    expect(beforeFirstEnds).toEqual(["first:start"]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(__pendingLocks()).toBe(0);
  });

  it("libera a fila após rejeição sem quebrar a ordem", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });

    const first = withSessionLock("session-reject", async () => {
      events.push("first:start");
      signalFirstStarted();
      await firstHold;
      events.push("first:end");
      throw new Error("falha esperada");
    });
    const second = withSessionLock("session-reject", async () => {
      events.push("second");
    });
    const third = withSessionLock("session-reject", async () => {
      events.push("third");
    });

    await firstStarted;
    expect(events).toEqual(["first:start"]);
    releaseFirst();

    await expect(first).rejects.toThrow("falha esperada");
    await Promise.all([second, third]);
    expect(events).toEqual(["first:start", "first:end", "second", "third"]);
    expect(__pendingLocks()).toBe(0);
  });

  it("permite sessões diferentes em paralelo", async () => {
    const events: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });

    const first = withSessionLock("session-a", async () => {
      events.push("a");
      await hold;
    });
    const second = withSessionLock("session-b", async () => {
      events.push("b");
    });
    await second;

    expect(events).toEqual(["a", "b"]);
    release();
    await first;
    expect(__pendingLocks()).toBe(0);
  });
});
