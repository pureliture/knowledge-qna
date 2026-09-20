/**
 * RobotsParser
 * Parses and evaluates robots.txt rules according to RFC 9309 / standard robots.txt semantics.
 * Strict Layer Boundary: Infrastructure imports only domain and application/ports.
 */

interface Rule {
  pattern: string;
  allow: boolean;
}

export class RobotsParser {
  private readonly rulesByAgent = new Map<string, Rule[]>();
  private readonly sitemaps: string[] = [];

  constructor(content: string = '') {
    this.parseContent(content);
  }

  static parse(content: string): RobotsParser {
    return new RobotsParser(content);
  }

  private parseContent(content: string): void {
    const lines = content.split(/\r?\n/);
    let currentAgents: string[] = [];

    for (const rawLine of lines) {
      // Strip comments
      const commentIdx = rawLine.indexOf('#');
      const line = (commentIdx !== -1 ? rawLine.slice(0, commentIdx) : rawLine).trim();
      if (!line) continue;

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const field = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();

      if (field === 'user-agent') {
        const agent = value.toLowerCase();
        // If transitioning from directives to a new agent block
        currentAgents.push(agent);
      } else if (field === 'disallow' || field === 'allow') {
        if (currentAgents.length === 0) {
          // Directive without preceding user-agent, associate with wildcard
          currentAgents = ['*'];
        }

        const isAllow = field === 'allow';
        const pattern = value;

        for (const agent of currentAgents) {
          if (!this.rulesByAgent.has(agent)) {
            this.rulesByAgent.set(agent, []);
          }
          this.rulesByAgent.get(agent)!.push({
            pattern,
            allow: isAllow,
          });
        }
      } else if (field === 'sitemap') {
        if (value) {
          this.sitemaps.push(value);
        }
      }
    }
  }

  /**
   * Returns all sitemap URLs discovered in the robots.txt.
   */
  getSitemaps(): string[] {
    return [...this.sitemaps];
  }

  /**
   * Checks whether the given URL or path is allowed for docsctx (or wildcard *).
   */
  isAllowed(urlOrPath: string): boolean {
    let pathname = urlOrPath;
    try {
      if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
        const parsed = new URL(urlOrPath);
        pathname = parsed.pathname + parsed.search;
      }
    } catch {
      pathname = urlOrPath;
    }

    if (!pathname.startsWith('/')) {
      pathname = '/' + pathname;
    }

    // Check docsctx specific rules first, then fallback to wildcard *
    const rules = this.rulesByAgent.get('docsctx') ?? this.rulesByAgent.get('*') ?? [];
    if (rules.length === 0) {
      return true;
    }

    let bestMatch: Rule | null = null;
    let maxMatchLen = -1;

    for (const rule of rules) {
      // Empty disallow: "Disallow:" means allow all
      if (!rule.allow && rule.pattern === '') {
        continue;
      }

      if (this.matchesRule(pathname, rule.pattern)) {
        const len = rule.pattern.length;
        if (len > maxMatchLen) {
          maxMatchLen = len;
          bestMatch = rule;
        } else if (len === maxMatchLen && rule.allow && bestMatch && !bestMatch.allow) {
          // If equal length, Allow takes precedence over Disallow
          bestMatch = rule;
        }
      }
    }

    if (!bestMatch) {
      return true;
    }

    return bestMatch.allow;
  }

  private matchesRule(pathname: string, pattern: string): boolean {
    if (!pattern) return false;

    // Standard robots prefix matching
    // Handle wildcard '*' or end-of-string '$'
    if (pattern.includes('*') || pattern.endsWith('$')) {
      let regexStr = '^';
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
          regexStr += '.*';
        } else if (c === '$' && i === pattern.length - 1) {
          regexStr += '$';
        } else if (['.', '+', '?', '^', '(', ')', '[', ']', '{', '}', '|', '\\', '$'].includes(c!)) {
          regexStr += '\\' + c;
        } else {
          regexStr += c;
        }
      }
      if (!pattern.endsWith('$')) {
        regexStr += '.*';
      }
      return new RegExp(regexStr).test(pathname);
    }

    // Default prefix match
    return pathname.startsWith(pattern);
  }
}
