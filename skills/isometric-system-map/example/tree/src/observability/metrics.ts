type Counter = { inc(n?: number): void; value(): number };

const registry = new Map<string, Counter>();

export function counter(name: string): Counter {
  if (!registry.has(name)) {
    let v = 0;
    registry.set(name, { inc: (n = 1) => { v += n; }, value: () => v });
  }
  return registry.get(name)!;
}

export function scrape(): string {
  return [...registry.entries()].map(([k, c]) => `${k} ${c.value()}`).join('\n');
}
