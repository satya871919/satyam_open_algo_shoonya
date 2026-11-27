/**
 * Comprehensive TradingView Pine Script (v4/v5/v6) -> OpenScript (version 1) transpiler.
 *
 * `openalgo-script`'s built-in `importScript` covers basic Pine indicators/strategies,
 * but real-world TradingView scripts use `ta.pivothigh`, `ta.pivotlow`, `str.tostring`,
 * `color.from_gradient`, `color.new`, `chart.point.from_index`, `box.new` / `.set_*`,
 * `label.new`, `plotchar`, `plotshape`, `barcolor`, `var box/label/color`, `:=`, and
 * multi-branch user functions.
 *
 * This module translates those Pine Script constructs into the exact `version 1`
 * library calls that `openalgo-script` compiles and `openalgo-charts` renders
 * (`pivotHigh`, `pivotLow`, `draw.box`, `draw.label`, `draw.setFillColor`,
 * `draw.setColor`, `signal`, `barColor`, `gradient`, `fade`, `text`, etc.).
 */

const BUILTIN_COLLISIONS = new Set([
  'sign',
  'text',
  'size',
  'line',
  'box',
  'label',
  'table',
  'level',
  'fill',
  'alert',
  'plot',
  'input',
  'color',
  'time',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'abs',
  'min',
  'max',
  'round',
  'floor',
  'ceil',
  'sqrt',
  'pow',
  'log',
  'sma',
  'ema',
  'atr',
  'rsi',
  'macd',
  'pivotHigh',
  'pivotLow',
  'highest',
  'lowest',
  'change',
  'rising',
  'falling',
  'cross',
])

const PINE_COLORS = [
  'aqua',
  'black',
  'blue',
  'fuchsia',
  'gray',
  'green',
  'lime',
  'maroon',
  'navy',
  'olive',
  'orange',
  'purple',
  'red',
  'silver',
  'teal',
  'white',
  'yellow',
]

function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = []
  let cur = ''
  let paren = 0
  let bracket = 0
  let quote: string | null = null

  for (let i = 0; i < argsText.length; i += 1) {
    const ch = argsText[i]
    if (quote) {
      cur += ch
      if (ch === '\\' && i + 1 < argsText.length) {
        cur += argsText[i + 1]
        i += 1
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '(') paren += 1
    else if (ch === ')') paren = Math.max(0, paren - 1)
    else if (ch === '[') bracket += 1
    else if (ch === ']') bracket = Math.max(0, bracket - 1)
    else if (ch === ',' && paren === 0 && bracket === 0) {
      args.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) args.push(cur.trim())
  return args
}

function parseNamedAndPositional(argsText: string): {
  positional: string[]
  named: Record<string, string>
} {
  const positional: string[] = []
  const named: Record<string, string> = {}
  for (const part of splitTopLevelArgs(argsText)) {
    const eqIdx = findTopLevelEquals(part)
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim()
      const val = part.slice(eqIdx + 1).trim()
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        named[key] = val
        continue
      }
    }
    positional.push(part)
  }
  return { positional, named }
}

function findTopLevelEquals(text: string): number {
  let paren = 0
  let bracket = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') paren += 1
    else if (ch === ')') paren = Math.max(0, paren - 1)
    else if (ch === '[') bracket += 1
    else if (ch === ']') bracket = Math.max(0, bracket - 1)
    else if (
      ch === '=' &&
      paren === 0 &&
      bracket === 0 &&
      text[i - 1] !== '!' &&
      text[i - 1] !== '<' &&
      text[i - 1] !== '>' &&
      text[i - 1] !== '=' &&
      text[i + 1] !== '='
    ) {
      return i
    }
  }
  return -1
}

function findMatchingParen(text: string, openIdx: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function replaceCall(
  line: string,
  fnNameRegex: RegExp,
  replacer: (argsText: string, fullMatch: string) => string
): string {
  let out = line
  let guard = 0
  while (guard < 30) {
    guard += 1
    fnNameRegex.lastIndex = 0
    const match = fnNameRegex.exec(out)
    if (!match) break
    const openIdx = match.index + match[0].length - 1
    const closeIdx = findMatchingParen(out, openIdx)
    if (closeIdx === -1) break
    const argsText = out.slice(openIdx + 1, closeIdx)
    const full = out.slice(match.index, closeIdx + 1)
    const replacement = replacer(argsText, full)
    out = out.slice(0, match.index) + replacement + out.slice(closeIdx + 1)
  }
  return out
}

function pineIndexToTime(expr: string): string {
  const trimmed = expr.trim()
  const sub = /^bar_index\s*-\s*(.+)$/.exec(trimmed)
  if (sub) {
    const offset = sub[1].trim()
    return `time[${offset}]`
  }
  if (trimmed === 'bar_index' || trimmed === 'bar.index') return 'time'
  return 'time'
}

/**
 * Convert single-quoted Pine strings `'...'` to double-quoted `"..."` strings
 * outside of comments and double-quoted strings.
 */
function normaliseQuotes(line: string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '/' && line[i + 1] === '/') {
      out += line.slice(i)
      break
    }
    if (ch === '"') {
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\' && j + 1 < line.length) {
          j += 2
          continue
        }
        if (line[j] === '"') {
          j += 1
          break
        }
        j += 1
      }
      out += line.slice(i, j)
      i = j
      continue
    }
    if (ch === "'") {
      let body = ''
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\' && j + 1 < line.length) {
          body += line[j + 1] === "'" ? "'" : line.slice(j, j + 2)
          j += 2
          continue
        }
        if (line[j] === "'") {
          j += 1
          break
        }
        body += line[j] === '"' ? '\\"' : line[j]
        j += 1
      }
      out += `"${body}"`
      i = j
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function stripInlineComment(line: string): { code: string; comment: string } {
  let quote: string | null = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '/' && line[i + 1] === '/') {
      return { code: line.slice(0, i), comment: line.slice(i) }
    }
  }
  return { code: line, comment: '' }
}

/** Replace identifiers outside string literals. */
function replaceIdentOutsideStrings(code: string, from: string, to: string): string {
  const re = new RegExp(`(?<![A-Za-z0-9_.])${from}(?![A-Za-z0-9_])`, 'g')
  let out = ''
  let i = 0
  while (i < code.length) {
    const ch = code[i]
    if (ch === '"') {
      let j = i + 1
      while (j < code.length) {
        if (code[j] === '\\') {
          j += 2
          continue
        }
        if (code[j] === '"') {
          j += 1
          break
        }
        j += 1
      }
      out += code.slice(i, j)
      i = j
      continue
    }
    const nextQuote = code.indexOf('"', i)
    const chunk = nextQuote === -1 ? code.slice(i) : code.slice(i, nextQuote)
    out += chunk.replace(re, to)
    i = nextQuote === -1 ? code.length : nextQuote
  }
  return out
}

function transformExpr(expr: string, boxVars: Set<string>, renamedVars: Map<string, string>): string {
  let s = expr

  // Apply local variable collision renames first
  for (const [orig, safe] of renamedVars) {
    s = replaceIdentOutsideStrings(s, orig, safe)
  }

  // Color names
  for (const c of PINE_COLORS) {
    s = s.replace(new RegExp(`\\bcolor\\.${c}\\b`, 'g'), c)
  }
  s = s.replace(/\bchart\.fg_color\b/g, 'white')
  s = s.replace(/\bchart\.bg_color\b/g, 'black')

  // color.new(c, transp) -> fade(c, transp)
  s = replaceCall(s, /\bcolor\.new\s*\(/g, (argsText) => {
    const { positional } = parseNamedAndPositional(argsText)
    return `fade(${positional[0] ?? 'white'}, ${positional[1] ?? '0'})`
  })

  // color.from_gradient(val, low, high, c1, c2) -> mix(c1, c2, clamp(...))
  s = replaceCall(s, /\bcolor\.from_gradient\s*\(/g, (argsText) => {
    const { positional } = parseNamedAndPositional(argsText)
    const val = positional[0] ?? '0'
    const lo = positional[1] ?? '0'
    const hi = positional[2] ?? '1'
    const c1 = positional[3] ?? 'green'
    const c2 = positional[4] ?? 'red'
    return `mix(${c1}, ${c2}, clamp((${val} - ${lo}) / max(0.000001, ${hi} - ${lo}), 0, 1))`
  })

  // color.rgb(...) -> rgb(...)
  s = replaceCall(s, /\bcolor\.rgb\s*\(/g, (argsText) => {
    const { positional } = parseNamedAndPositional(argsText)
    return `rgb(${positional.slice(0, 3).join(', ')})`
  })

  // str.tostring(val, ...) -> text(val)
  s = replaceCall(s, /\bstr\.tostring\s*\(/g, (argsText) => {
    const { positional } = parseNamedAndPositional(argsText)
    return `text(${positional[0] ?? '""'})`
  })

  // nz(a, b) -> orElse(a, b)
  s = replaceCall(s, /\bnz\s*\(/g, (argsText) => {
    const { positional } = parseNamedAndPositional(argsText)
    return `orElse(${positional[0] ?? '0'}, ${positional[1] ?? '0'})`
  })

  // na(x) -> isNone(x)
  s = replaceCall(s, /\bna\s*\(/g, (argsText) => {
    const { positional } = parseNamedAndPositional(argsText)
    return `isNone(${positional[0] ?? 'none'})`
  })

  // Box na checks: `not na(sup)` -> `_has_sup`, `na(sup)` -> `not _has_sup`
  for (const bv of boxVars) {
    s = s.replace(new RegExp(`\\bnot\\s+isNone\\(${bv}\\)`, 'g'), `_has_${bv}`)
    s = s.replace(new RegExp(`\\bisNone\\(${bv}\\)`, 'g'), `not _has_${bv}`)
  }

  // TA & math mappings
  const taMap: Record<string, string> = {
    'ta.pivothigh': 'pivotHigh',
    'ta.pivotlow': 'pivotLow',
    'ta.sma': 'sma',
    'ta.ema': 'ema',
    'ta.wma': 'wma',
    'ta.rma': 'rma',
    'ta.hma': 'hma',
    'ta.vwma': 'vwma',
    'ta.atr': 'atr',
    'ta.rsi': 'rsi',
    'ta.macd': 'macd',
    'ta.stoch': 'stoch',
    'ta.cci': 'cci',
    'ta.supertrend': 'supertrend',
    'ta.highest': 'highest',
    'ta.lowest': 'lowest',
    'ta.highestbars': 'highestBars',
    'ta.lowestbars': 'lowestBars',
    'ta.crossover': 'crossUp',
    'ta.crossunder': 'crossDown',
    'ta.cross': 'cross',
    'ta.valuewhen': 'valueWhen',
    'ta.barssince': 'barsSince',
    'ta.change': 'change',
    'ta.cum': 'cum',
    'ta.stdev': 'stdev',
    'ta.rising': 'rising',
    'ta.falling': 'falling',
    'math.abs': 'abs',
    'math.max': 'max',
    'math.min': 'min',
    'math.round': 'round',
    'math.floor': 'floor',
    'math.ceil': 'ceil',
    'math.sqrt': 'sqrt',
    'math.pow': 'pow',
    'math.log': 'log',
    'math.log10': 'log10',
    'math.sign': 'sign',
  }
  for (const [pineFn, osFn] of Object.entries(taMap)) {
    s = s.replace(new RegExp(`\\b${pineFn.replace('.', '\\.')}\\s*\\(`, 'g'), `${osFn}(`)
  }

  // input.* -> input(...)
  s = replaceCall(
    s,
    /\binput\.(?:bool|int|float|string|color|source)\s*\(/g,
    (argsText) => {
      const { positional, named } = parseNamedAndPositional(argsText)
      const outArgs = [...positional]
      for (const [k, v] of Object.entries(named)) {
        if (k === 'minval') outArgs.push(`min = ${v}`)
        else if (k === 'maxval') outArgs.push(`max = ${v}`)
        else if (k === 'defval') outArgs.unshift(v)
        else if (k === 'title') outArgs.push(v)
        else if (k === 'step' || k === 'group' || k === 'tooltip') outArgs.push(`${k} = ${v}`)
      }
      return `input(${outArgs.join(', ')})`
    }
  )

  // Plot styles & formats
  s = s.replace(/\bplot\.style_columns\b/g, '"column"')
  s = s.replace(/\bplot\.style_histogram\b/g, '"histogram"')
  s = s.replace(/\bplot\.style_stepline\b/g, '"step"')
  s = s.replace(/\bplot\.style_area\b/g, '"area"')
  s = s.replace(/\bplot\.style_line\b/g, '"line"')
  s = s.replace(/\bformat\.volume\b/g, '"volume"')
  s = s.replace(/\bformat\.percent\b/g, '"percent"')
  s = s.replace(/\bformat\.price\b/g, '"price"')
  s = s.replace(/\blinewidth\s*=/g, 'width =')

  // Standalone identifiers outside strings
  s = replaceIdentOutsideStrings(s, 'bar_index', 'bar.index')
  s = replaceIdentOutsideStrings(s, 'na', 'none')
  s = s.replace(/\s*:=\s*/g, ' = ')

  return s
}

/**
 * Convert `if/else if/else` inside a user-defined function body into a
 * chained ternary expression so `fn name(args) => ...` compiles cleanly in `version 1`.
 */
function convertFnBodyIfChain(bodyLines: { indent: number; text: string }[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < bodyLines.length) {
    const cur = bodyLines[i]
    const ifMatch = /^if\s+(.+)$/.exec(cur.text.trim())
    if (!ifMatch) {
      out.push(' '.repeat(cur.indent) + cur.text.trim())
      i += 1
      continue
    }
    const baseIndent = cur.indent
    const branches: { cond: string | null; expr: string }[] = []
    let j = i
    while (j < bodyLines.length) {
      const line = bodyLines[j]
      if (line.indent !== baseIndent) break
      const t = line.text.trim()
      const mIf = /^if\s+(.+)$/.exec(t)
      const mElif = /^else\s+if\s+(.+)$/.exec(t)
      const mElse = /^else$/.exec(t)
      if (mIf && branches.length === 0 && j + 1 < bodyLines.length) {
        branches.push({ cond: mIf[1], expr: bodyLines[j + 1].text.trim() })
        j += 2
      } else if (mElif && branches.length > 0 && j + 1 < bodyLines.length) {
        branches.push({ cond: mElif[1], expr: bodyLines[j + 1].text.trim() })
        j += 2
      } else if (mElse && branches.length > 0 && j + 1 < bodyLines.length) {
        branches.push({ cond: null, expr: bodyLines[j + 1].text.trim() })
        j += 2
        break
      } else {
        break
      }
    }
    if (branches.length >= 2 && branches[branches.length - 1].cond === null) {
      let ternary = branches[branches.length - 1].expr
      for (let k = branches.length - 2; k >= 0; k -= 1) {
        ternary = `${branches[k].cond} ? ${branches[k].expr} : (${ternary})`
      }
      out.push(' '.repeat(baseIndent) + ternary)
      i = j
    } else {
      out.push(' '.repeat(cur.indent) + cur.text.trim())
      i += 1
    }
  }
  return out
}

export function transpilePineToOpenScript(pineSource: string): string {
  const rawLines = pineSource.replace(/\r\n?/g, '\n').split('\n')

  // Track box variables (`var box sup = na`), chart.point variables (`topLeft`),
  // and local variable names that collide with `openalgo-script` built-ins.
  const boxVars = new Set<string>()
  const boxBottomPrice = new Map<string, string>()
  const chartPoints = new Map<string, { t: string; p: string }>()
  const renamedVars = new Map<string, string>()

  // First pass: discover `var box <name>`, `box <name>`, and colliding local vars
  for (const raw of rawLines) {
    const { code } = stripInlineComment(raw)
    const trimmed = code.trim()
    const boxMatch =
      /^(?:varip|var)?\s*box\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::?=)/.exec(trimmed)
    if (boxMatch) boxVars.add(boxMatch[1])

    const declMatch =
      /^(?:varip|var)?\s*(?:bool|int|float|string|color)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::?=)/.exec(
        trimmed
      )
    if (declMatch && BUILTIN_COLLISIONS.has(declMatch[1])) {
      renamedVars.set(declMatch[1], `_v_${declMatch[1]}`)
    }
  }

  const outLines: string[] = ['version 1']
  let i = 0

  while (i < rawLines.length) {
    const raw = normaliseQuotes(rawLines[i])
    const leadingSpaces = raw.match(/^\s*/)?.[0] ?? ''
    const { code, comment } = stripInlineComment(raw)
    const trimmed = code.trim()

    // Skip //@version=...
    if (/^\/\/\s*@version\s*=/.test(raw.trim())) {
      i += 1
      continue
    }

    // Pure blank or comment line
    if (!trimmed) {
      outLines.push(comment ? `${leadingSpaces}${comment}` : '')
      i += 1
      continue
    }

    // Header: indicator(...) / strategy(...)
    if (/^(?:indicator|study)\s*\(/.test(trimmed)) {
      const converted = replaceCall(trimmed, /^(?:indicator|study)\s*\(/g, (argsText) => {
        const { positional, named } = parseNamedAndPositional(argsText)
        const kept: string[] = [...positional]
        for (const [k, v] of Object.entries(named)) {
          if (k === 'shorttitle') kept.push(`short = ${v}`)
          else if (k === 'overlay' || k === 'short' || k === 'precision') kept.push(`${k} = ${v}`)
        }
        return `study(${kept.join(', ')})`
      })
      outLines.push(`${leadingSpaces}${converted}`)
      i += 1
      continue
    }

    if (/^strategy\s*\(/.test(trimmed)) {
      const converted = replaceCall(trimmed, /^strategy\s*\(/g, (argsText) => {
        const { positional, named } = parseNamedAndPositional(argsText)
        const kept: string[] = [...positional]
        for (const [k, v] of Object.entries(named)) {
          if (k === 'default_qty_value') kept.push(`qty = ${v}`)
          else if (k === 'initial_capital') kept.push(`capital = ${v}`)
          else if (k === 'overlay' || k === 'qty' || k === 'capital') kept.push(`${k} = ${v}`)
        }
        return `strategy(${kept.join(', ')})`
      })
      outLines.push(`${leadingSpaces}${converted}`)
      i += 1
      continue
    }

    // User-defined function: `name(params) =>`
    const fnMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*=>$/.exec(trimmed)
    if (fnMatch) {
      const fnName = fnMatch[1]
      const fnParams = fnMatch[2]
      const fnIndent = leadingSpaces.length
      const bodyRaw: { indent: number; text: string }[] = []
      i += 1
      while (i < rawLines.length) {
        const bRaw = normaliseQuotes(rawLines[i])
        const bIndent = (bRaw.match(/^\s*/)?.[0] ?? '').length
        const { code: bCode } = stripInlineComment(bRaw)
        const bTrim = bCode.trim()
        if (!bTrim) {
          i += 1
          continue
        }
        if (bIndent <= fnIndent) break
        const cleaned = bTrim.replace(
          /^(?:varip|var)?\s*(?:bool|int|float|string|color)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(:?=)/,
          '$1 $2'
        )
        bodyRaw.push({ indent: bIndent, text: transformExpr(cleaned, boxVars, renamedVars) })
        i += 1
      }
      outLines.push(`${leadingSpaces}fn ${fnName}(${fnParams}) =>`)
      for (const bLine of convertFnBodyIfChain(bodyRaw)) {
        outLines.push(bLine)
      }
      continue
    }

    // chart.point.from_index(idx, price)
    const cpMatch =
      /^(?:chart\.point\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*chart\.point\.from_index\s*\((.+)\)$/.exec(
        trimmed
      )
    if (cpMatch) {
      const varName = cpMatch[1]
      const { positional } = parseNamedAndPositional(cpMatch[2])
      const tExpr = pineIndexToTime(positional[0] ?? 'bar_index')
      const pExpr = transformExpr(positional[1] ?? 'close', boxVars, renamedVars)
      chartPoints.set(varName, { t: tExpr, p: pExpr })
      i += 1
      continue
    }

    // `var box sup = na` -> `var sup = draw.box(...)` + `var _has_sup = false`
    const varBoxNa = /^(?:varip|var)\s+box\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*na$/.exec(trimmed)
    if (varBoxNa) {
      const bv = varBoxNa[1]
      outLines.push(`${leadingSpaces}var ${bv} = draw.box(time, close, time, close, color = none)`)
      outLines.push(`${leadingSpaces}var _has_${bv} = false`)
      i += 1
      continue
    }

    // `var label/line/color/float/bool/int/string x = ...`
    const varTyped =
      /^(?:varip|var)\s+(?:bool|int|float|string|color|label|line)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(
        trimmed
      )
    if (varTyped) {
      const vName = renamedVars.get(varTyped[1]) ?? varTyped[1]
      const rhs = transformExpr(varTyped[2], boxVars, renamedVars)
      outLines.push(`${leadingSpaces}var ${vName} = ${rhs}`)
      i += 1
      continue
    }

    // `sup := box.new(...)` or `box sup = box.new(...)`
    const boxAssign =
      /^(?:box\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*box\.new\s*\((.+)\)$/.exec(trimmed)
    if (boxAssign) {
      const bv = boxAssign[1]
      const { positional, named } = parseNamedAndPositional(boxAssign[2])
      let t1 = 'time'
      let p1 = 'high'
      let t2 = 'time'
      let p2 = 'low'
      if (named.top_left && chartPoints.has(named.top_left)) {
        const pt = chartPoints.get(named.top_left)!
        t1 = pt.t
        p1 = pt.p
      } else if (positional.length >= 4) {
        t1 = pineIndexToTime(positional[0])
        p1 = transformExpr(positional[1], boxVars, renamedVars)
        t2 = pineIndexToTime(positional[2])
        p2 = transformExpr(positional[3], boxVars, renamedVars)
      }
      if (named.bottom_right && chartPoints.has(named.bottom_right)) {
        const pt = chartPoints.get(named.bottom_right)!
        t2 = pt.t
        p2 = pt.p
      }
      const args = [t1, p1, t2, p2]
      if (named.border_color)
        args.push(`color = ${transformExpr(named.border_color, boxVars, renamedVars)}`)
      if (named.bgcolor)
        args.push(`fillColor = ${transformExpr(named.bgcolor, boxVars, renamedVars)}`)
      if (named.border_width) args.push(`width = ${named.border_width}`)
      if (named.text) args.push(`text = ${transformExpr(named.text, boxVars, renamedVars)}`)
      if (named.text_color)
        args.push(`textColor = ${transformExpr(named.text_color, boxVars, renamedVars)}`)
      outLines.push(`${leadingSpaces}${bv} = draw.box(${args.join(', ')})`)
      boxBottomPrice.set(bv, p2)
      if (boxVars.has(bv)) outLines.push(`${leadingSpaces}_has_${bv} = true`)
      i += 1
      continue
    }

    // Box method calls: `sup.set_right(...)`, `sup.set_bgcolor(...)`, `sup.set_border_color(...)`, `sup.set_border_style(...)`
    const boxMethod = /^([A-Za-z_][A-Za-z0-9_]*)\.(set_right|set_bgcolor|set_border_color|set_border_style)\s*\((.+)\)$/.exec(
      trimmed
    )
    if (boxMethod) {
      const [, bv, method, arg] = boxMethod
      const cleanArg = transformExpr(arg, boxVars, renamedVars)
      if (method === 'set_bgcolor') {
        outLines.push(`${leadingSpaces}draw.setFillColor(${bv}, ${cleanArg})`)
      } else if (method === 'set_border_color') {
        outLines.push(`${leadingSpaces}draw.setColor(${bv}, ${cleanArg})`)
      } else if (method === 'set_right' && boxBottomPrice.has(bv)) {
        outLines.push(`${leadingSpaces}draw.setTo(${bv}, ${pineIndexToTime(arg)}, ${boxBottomPrice.get(bv)})`)
      } else if (method === 'set_border_style' && !boxVars.has(bv)) {
        const styleVal = arg.includes('dashed')
          ? '"dashed"'
          : arg.includes('dotted')
            ? '"dotted"'
            : '"solid"'
        outLines.push(`${leadingSpaces}draw.setStyle(${bv}, ${styleVal})`)
      } else {
        // Keep a valid no-op statement so `if` blocks with only unknown box calls never become empty
        outLines.push(`${leadingSpaces}_pine_noop = 0`)
      }
      i += 1
      continue
    }

    // `label.new(...)`
    const labelCall = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*)?label\.new\s*\((.+)\)$/.exec(trimmed)
    if (labelCall) {
      const { positional, named } = parseNamedAndPositional(labelCall[1])
      const tExpr = pineIndexToTime(positional[0] ?? named.x ?? 'bar_index')
      const pExpr = transformExpr(positional[1] ?? named.y ?? 'close', boxVars, renamedVars)
      const txtExpr = transformExpr(named.text ?? positional[2] ?? '""', boxVars, renamedVars)
      const colExpr = named.color ? transformExpr(named.color, boxVars, renamedVars) : 'blue'
      const txtColExpr = named.textcolor
        ? transformExpr(named.textcolor, boxVars, renamedVars)
        : 'white'
      outLines.push(`${leadingSpaces}draw.label(${tExpr}, ${pExpr}, ${txtExpr}, color = ${colExpr}, textColor = ${txtColExpr})`)
      i += 1
      continue
    }

    // `plotchar(cond, title, char, ...)` / `plotshape(cond, ...)`
    const plotMarker = /^(plotchar|plotshape)\s*\((.+)\)$/.exec(trimmed)
    if (plotMarker) {
      const { positional, named } = parseNamedAndPositional(plotMarker[2])
      const cond = transformExpr(positional[0] ?? 'false', boxVars, renamedVars)
      const title = transformExpr(named.title ?? positional[1] ?? '"Signal"', boxVars, renamedVars)
      const col = named.color ? transformExpr(named.color, boxVars, renamedVars) : 'aqua'
      const locRaw = named.location ?? ''
      const at = locRaw.includes('abovebar') ? '"above"' : '"below"'
      const shape = plotMarker[1] === 'plotchar' ? '"diamond"' : '"triangleUp"'
      outLines.push(`${leadingSpaces}if ${cond}`)
      outLines.push(`${leadingSpaces}    signal(${title}, color = ${col}, at = ${at}, shape = ${shape})`)
      i += 1
      continue
    }

    // `barcolor(expr)`
    const barCol = /^barcolor\s*\((.+)\)$/.exec(trimmed)
    if (barCol) {
      const expr = transformExpr(barCol[1], boxVars, renamedVars)
      outLines.push(`${leadingSpaces}barColor(${expr})`)
      i += 1
      continue
    }

    // Strip non-var type annotation on assignment: `float x = ...` -> `x = ...`
    const typedAssign =
      /^(?:bool|int|float|string|color|label|line)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(:?=)\s*(.+)$/.exec(
        trimmed
      )
    if (typedAssign) {
      const vName = renamedVars.get(typedAssign[1]) ?? typedAssign[1]
      const rhs = transformExpr(typedAssign[3], boxVars, renamedVars)
      outLines.push(`${leadingSpaces}${vName} = ${rhs}`)
      i += 1
      continue
    }

    // Generic line
    outLines.push(`${leadingSpaces}${transformExpr(trimmed, boxVars, renamedVars)}`)
    i += 1
  }

  return `${outLines.join('\n')}\n`
}
