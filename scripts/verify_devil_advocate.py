#!/usr/bin/env python3
"""
Devil's Advocate Output Verifier

Validates that a devil-advocate evaluation file meets the quality standards
defined in the role specification. Checks both format compliance and
substantive quality signals.

Usage:
    python3 verify_devil_advocate.py <eval-file.md>
    python3 verify_devil_advocate.py /tmp/devil-advocate-sim/round-1.md

Exit codes:
    0 — all checks pass
    1 — format/quality violations found
"""

import re
import sys
from pathlib import Path
from dataclasses import dataclass, field


@dataclass
class Challenge:
    number: int
    status: str  # OPEN, SEALED, ESCALATED
    title: str
    has_assumption: bool = False
    has_failure_scenario: bool = False
    has_convince_me: bool = False
    has_alternative: bool = False
    is_specific: bool = False  # failure scenario names concrete conditions


@dataclass
class VerificationResult:
    file_path: str
    challenges: list = field(default_factory=list)
    verdict: str = ""
    verdict_count: int = 0
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return len(self.errors) == 0


def parse_challenges(content: str) -> list[Challenge]:
    """Extract challenge blocks from the evaluation."""
    challenges = []

    # Match challenge headers: ### [STATUS] Challenge N: title
    # Also handles transition markers like [OPEN → NARROWED] or [OPEN → SEALED]
    pattern = r'###\s+\[([^\]]+)\]\s+Challenge\s+(\d+):\s*(.+?)(?:\n|$)'
    headers = list(re.finditer(pattern, content))

    for i, match in enumerate(headers):
        status_raw = match.group(1).strip()
        # Normalize status — handle transition markers like "OPEN → SEALED", "OPEN → NARROWED"
        # Take the LAST status word in transitions, but also check the block body
        if '→' in status_raw or '—' in status_raw:
            parts = re.split(r'[→—]', status_raw)
            status_raw = parts[-1].strip()

        if 'SEALED' in status_raw:
            status = 'SEALED'
        elif 'ESCALATED' in status_raw:
            status = 'ESCALATED'
        elif 'NARROWED' in status_raw:
            # NARROWED is still OPEN but scoped down — check block body for final seal
            status = 'OPEN'  # default to OPEN, override below if body says SEALED
        else:
            status = 'OPEN'

        num = int(match.group(2))
        title = match.group(3).strip()

        # Get the block content until next challenge, next H2 section, or section separator
        start = match.end()
        if i + 1 < len(headers):
            end = headers[i + 1].start()
        else:
            # Last challenge — don't include summary/verdict sections
            # Stop at next ## header or --- separator (whichever comes first)
            remaining = content[start:]
            section_break = re.search(r'\n## |\n---\s*\n', remaining)
            end = start + section_break.start() if section_break else len(content)
        block = content[start:end]

        c = Challenge(number=num, status=status, title=title)

        # Check if the block body overrides the header status
        # e.g., header says [OPEN → NARROWED] but body concludes with **[SEALED]**
        if status == 'OPEN' and re.search(r'\*\*\[SEALED\]\*\*|\*\*\s*\[SEALED\]', block):
            c.status = 'SEALED'
            status = 'SEALED'

        c.has_assumption = bool(re.search(r'\*\*Assumption under attack', block))
        c.has_failure_scenario = bool(re.search(r'\*\*Failure scenario', block))
        c.has_convince_me = bool(re.search(r'\*\*What would convince me', block))
        c.has_alternative = bool(re.search(r'\*\*If I\'m right', block))

        # Check specificity: failure scenario should contain conditional language
        # "Under X", "When Y", "If Z happens" — not just "might fail"
        if c.has_failure_scenario:
            fs_match = re.search(r'\*\*Failure scenario:\*\*\s*(.+?)(?:\n\n|\*\*)', block, re.DOTALL)
            if fs_match:
                fs_text = fs_match.group(1)
                # Specific = contains concrete conditions, not just "might" or "could"
                vague_markers = ['might', 'could potentially', 'may possibly', 'there is a risk']
                specific_markers = ['when', 'if ', 'at ', 'under ', 'once ', 'after ']
                has_vague = any(m in fs_text.lower() for m in vague_markers)
                has_specific = any(m in fs_text.lower() for m in specific_markers)
                c.is_specific = has_specific and not (has_vague and not has_specific)

        challenges.append(c)

    return challenges


def parse_verdict(content: str) -> tuple[str, int]:
    """Extract verdict and count."""
    # VERDICT: UNCONVINCED [N]
    m = re.search(r'VERDICT:\s*UNCONVINCED\s*\[(\d+)\]', content)
    if m:
        return 'UNCONVINCED', int(m.group(1))

    # VERDICT: CONVINCED
    if re.search(r'VERDICT:\s*CONVINCED', content):
        return 'CONVINCED', 0

    # VERDICT: FATAL
    m = re.search(r'VERDICT:\s*FATAL', content)
    if m:
        return 'FATAL', 0

    return '', 0


def verify(file_path: str) -> VerificationResult:
    """Run all verification checks on a devil-advocate output file."""
    result = VerificationResult(file_path=file_path)

    content = Path(file_path).read_text()

    # --- Parse ---
    result.challenges = parse_challenges(content)
    result.verdict, result.verdict_count = parse_verdict(content)

    # --- Format checks ---
    if not result.challenges:
        result.errors.append("NO_CHALLENGES: No challenge blocks found. Expected ### [STATUS] Challenge N: title")
        return result

    if not result.verdict:
        result.errors.append("NO_VERDICT: No VERDICT line found. Expected VERDICT: UNCONVINCED [N] / CONVINCED / FATAL")

    # --- Per-challenge quality checks ---
    open_challenges = [c for c in result.challenges if c.status == 'OPEN']
    sealed_challenges = [c for c in result.challenges if c.status == 'SEALED']

    for c in result.challenges:
        prefix = f"Challenge {c.number}"

        if c.status == 'OPEN':
            # OPEN challenges MUST have all four sections
            if not c.has_assumption:
                result.errors.append(f"{prefix}: MISSING_ASSUMPTION — open challenge must state the assumption under attack")
            if not c.has_failure_scenario:
                result.errors.append(f"{prefix}: MISSING_FAILURE_SCENARIO — open challenge must construct a concrete failure scenario")
            if not c.has_convince_me:
                result.errors.append(f"{prefix}: MISSING_DEFEAT_CONDITIONS — open challenge must state what would convince the devil's advocate")
            if not c.has_alternative:
                result.errors.append(f"{prefix}: MISSING_ALTERNATIVE — open challenge must propose an alternative ('if I'm right...')")
            if c.has_failure_scenario and not c.is_specific:
                result.warnings.append(f"{prefix}: VAGUE_SCENARIO — failure scenario uses vague language ('might', 'could') without concrete conditions")

        elif c.status == 'SEALED':
            # SEALED challenges should explain what sealed them
            pass  # We check the overall count below

    # --- Verdict consistency ---
    if result.verdict == 'UNCONVINCED':
        actual_open = len(open_challenges)
        if result.verdict_count != actual_open:
            result.errors.append(
                f"VERDICT_MISMATCH: UNCONVINCED [{result.verdict_count}] but found {actual_open} [OPEN] challenges"
            )

    if result.verdict == 'CONVINCED' and open_challenges:
        result.errors.append(
            f"VERDICT_INCONSISTENT: CONVINCED but {len(open_challenges)} challenges still [OPEN]"
        )

    # --- Quality signals ---
    if len(result.challenges) < 3:
        result.warnings.append(f"LOW_CHALLENGE_COUNT: Only {len(result.challenges)} challenges. Expected 3+ for a substantive review.")

    if not open_challenges and not sealed_challenges:
        result.warnings.append("NO_STATUS_MARKERS: No challenges have [OPEN] or [SEALED] status")

    # Check for "troll" pattern: all challenges OPEN, no self-sealing
    if len(open_challenges) == len(result.challenges) and len(result.challenges) > 5:
        result.warnings.append("POSSIBLE_TROLLING: All challenges are OPEN — devil's advocate may be opposing without willingness to be convinced")

    # Check for "rubber stamp" pattern: all challenges SEALED
    if len(sealed_challenges) == len(result.challenges) and result.verdict != 'CONVINCED':
        result.errors.append("INCONSISTENT: All challenges SEALED but verdict is not CONVINCED")

    # Loopback detection: check if this references a previous devil-advocate round
    # Match "Round 2" in the title/header (not in discussion context), or explicit loopback/previous-round markers
    is_loopback = bool(re.search(
        r'(?:Evaluation|Advocate).*[Rr]ound\s*[2-9]|[Ll]oopback|[Pp]revious.*round.*round-\d|[Pp]revious\s+status:\s*\[',
        content
    ))
    if is_loopback:
        # Cross-run tracking checks
        has_status_transitions = bool(re.search(r'\[OPEN\].*→.*\[SEALED\]|\*\*Previous status:\*\*', content))
        if not has_status_transitions:
            result.warnings.append("LOOPBACK_NO_TRACKING: This appears to be a loopback round but doesn't track status transitions from previous round")

    return result


def print_result(result: VerificationResult):
    """Print human-readable verification report."""
    print(f"\n{'='*60}")
    print(f"  Devil's Advocate Verification Report")
    print(f"  File: {result.file_path}")
    print(f"{'='*60}\n")

    # Summary
    open_count = len([c for c in result.challenges if c.status == 'OPEN'])
    sealed_count = len([c for c in result.challenges if c.status == 'SEALED'])
    print(f"  Challenges: {len(result.challenges)} total ({open_count} open, {sealed_count} sealed)")
    print(f"  Verdict: {result.verdict}" + (f" [{result.verdict_count}]" if result.verdict_count else ""))
    print()

    # Per-challenge
    print("  Challenge Quality:")
    for c in result.challenges:
        status_icon = "🔴" if c.status == 'OPEN' else ("🟢" if c.status == 'SEALED' else "⚠️")
        sections = []
        if c.has_assumption: sections.append("assumption")
        if c.has_failure_scenario: sections.append("scenario" + ("✓" if c.is_specific else "⚠"))
        if c.has_convince_me: sections.append("defeat-cond")
        if c.has_alternative: sections.append("alternative")
        print(f"    {status_icon} #{c.number}: {c.title}")
        print(f"       Sections: [{', '.join(sections) or 'none'}]")
    print()

    # Errors
    if result.errors:
        print(f"  ❌ ERRORS ({len(result.errors)}):")
        for e in result.errors:
            print(f"    • {e}")
        print()

    # Warnings
    if result.warnings:
        print(f"  ⚠️  WARNINGS ({len(result.warnings)}):")
        for w in result.warnings:
            print(f"    • {w}")
        print()

    # Final
    if result.passed:
        print("  ✅ PASSED — output meets devil's advocate quality standards")
    else:
        print("  ❌ FAILED — output has quality violations")

    print()
    return result.passed


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <eval-file.md>")
        sys.exit(2)

    file_path = sys.argv[1]
    if not Path(file_path).exists():
        print(f"Error: {file_path} does not exist")
        sys.exit(2)

    result = verify(file_path)
    passed = print_result(result)
    sys.exit(0 if passed else 1)
