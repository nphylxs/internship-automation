"""Conservative, explainable routing for internship listings.

This is a queueing aid, not a legal or work-authorization determination.  Missing
evidence goes to review; a listing never qualifies merely by omitting citizenship
restrictions.  Every textual authorization evidence item is copied from the input.
"""

import re
from datetime import date


def _text(value):
    if isinstance(value, (list, tuple)):
        return ", ".join(str(item) for item in value)
    return str(value or "")


def _has(pattern, text):
    return bool(re.search(pattern, text, flags=re.I))


def _sentences(text):
    # Avoid splitting U.S., decimal values, and punctuation without whitespace.
    return [part.strip() for part in re.split(r"\n+|(?<=[!?])\s+|(?<=[a-z0-9])\.\s+(?=[A-Z])", text) if part.strip()]


AUTH_TERM = r"(?:\bCPT\b|\bcurricular practical training\b|\bOPT\b|\bF[ -]?1\b|\binternational students?\b)"
ACCEPT = r"\b(?:accept(?:s|ed|ing)?|consider(?:s|ed|ing)?|welcome(?:s|d)?|eligible|permitted|allowed|may apply|can apply|encouraged to apply|invited to apply|open to|hire|hiring)\b"
NEGATIVE_AUTH = [
    rf"(?:do(?:es)? not|will not|are not|is not|cannot|can['’]t|don['’]t|doesn['’]t|won['’]t|not able to|unable to)\s+(?:\w+\s+){{0,3}}(?:accept(?:ing)?|consider(?:ing)?|hir(?:e|ing)|employ(?:ing)?)\b.{{0,90}}{AUTH_TERM}",
    rf"{AUTH_TERM}.{{0,60}}(?:not(?:\s+\w+){{0,3}}\s+(?:eligible|accepted|permitted|allowed|considered|welcome)|ineligible|cannot apply|may not apply|are excluded)",
    rf"(?:not open to|not eligible for|no)\s+(?:\w+\s+){{0,3}}{AUTH_TERM}",
    rf"{AUTH_TERM}\s+(?:candidates?|students?|applicants?)\s+(?:are\s+)?not\s+(?:accepted|eligible|considered)",
]
CITIZEN = r"(?:U\.?\s?S\.?\s+(?:citizens?(?:hip)?|persons?)|United States citizens?(?:hip)?|American citizens?(?:hip)?|permanent residents?)"
CITIZEN_RESTRICTIONS = [
    rf"(?:must|shall|need to|required to)\s+(?:\w+\s+){{0,3}}(?:be|hold|have)\s+(?:a\s+|an\s+)?{CITIZEN}",
    rf"(?:only|exclusively)\s+(?:\w+\s+){{0,2}}{CITIZEN}",
    rf"{CITIZEN}.{{0,45}}(?:required|mandatory|only)",
    rf"(?:requires?|limited to|restricted to)\s+(?:\w+\s+){{0,2}}{CITIZEN}",
]


def _authorization(job, body):
    positive, negative, context = [], [], []
    export_review = False
    for sentence in _sentences(body):
        # "Citizenship is not required" is deliberately not a positive acceptance.
        citizenship = any(_has(pattern, sentence) for pattern in CITIZEN_RESTRICTIONS)
        if _has(r"(?:citizenship|citizen|permanent resident).{0,30}(?:not required|is not a requirement)|(?:does not|do not) require.{0,30}citizen", sentence):
            citizenship = False
        if citizenship and _has(r"\bor\b.{0,60}export.{0,20}(?:licen[sc]e|authori[sz]ation)", sentence):
            citizenship = False
            export_review = True
            context.append(sentence)
        for clause in re.split(r";|\bbut\b|\bhowever\b", sentence, flags=re.I):
            negative_auth = any(_has(pattern, clause) for pattern in NEGATIVE_AUTH)
            has_auth_term = _has(AUTH_TERM, clause)
            positive_auth = has_auth_term and (
                _has(rf"{ACCEPT}.{{0,95}}{AUTH_TERM}", clause)
                or _has(rf"{AUTH_TERM}.{{0,95}}{ACCEPT}", clause)
            )
            if negative_auth:
                negative.append(sentence)
            elif positive_auth:
                # Questions and conditional offers are not confirmed acceptance.
                if "?" in clause or _has(r"\b(?:unless|except|might|depending)\b|not all|may be eligible|case[ -]by[ -]case|subject to", clause):
                    context.append(sentence)
                else:
                    positive.append(sentence)
        if citizenship:
            negative.append(sentence)
        if _has(r"\bITAR\b|export[ -]control|security clearance|\bEAR\b", sentence):
            context.append(sentence)
            if not citizenship:
                export_review = True
        if _has(r"sponsor(?:ship|ing)?|work authori[sz]ation|authori[sz]ed to work", sentence):
            context.append(sentence)

    structured = job.get("structured_authorization") or {}
    if isinstance(structured, dict):
        if structured.get("requires_citizenship") is True:
            negative.append("structured_authorization.requires_citizenship=true")
        for field in ("accepts_cpt", "accepts_opt", "accepts_international"):
            value = structured.get(field)
            if value is True:
                positive.append(f"structured_authorization.{field}=true")
            elif value is False:
                negative.append(f"structured_authorization.{field}=false")
        if isinstance(structured.get("sponsorship"), bool):
            context.append("structured_authorization.sponsorship=" + str(structured["sponsorship"]).lower())
    contradictory = bool(positive and negative)
    status = "unknown" if contradictory else "excluded" if negative else "supported" if positive else "unknown"
    evidence = list(dict.fromkeys(positive + negative + context))
    cpt_positive = any(_has(r"\bCPT\b|curricular practical training|accepts_cpt=true", item) for item in positive)
    complete = bool(_text(job.get("description")).strip()) and not job.get("description_is_summary")
    category = ("discarded" if negative else
                "review" if export_review or not complete else
                "cpt_accepted" if cpt_positive else
                "international_accepted" if positive else
                "review" if _has(AUTH_TERM, body) else "risky")
    return {"status": status, "evidence": evidence, "category": category}, contradictory, export_review


TEMPLATE_TERMS = {
    "fpga": [
        (r"\bFPGA\b", 6), (r"\bRTL\b", 5), (r"\bSystemVerilog\b|\bVerilog\b", 5),
        (r"\bVHDL\b", 5), (r"digital (?:logic|design|circuits?)", 4),
        (r"\bASIC\b|\bVLSI\b", 4), (r"\bUVM\b", 4), (r"design verification", 4),
    ],
    "robotics": [
        (r"\brobotics?\b", 4), (r"\bembedded\b", 4), (r"\bfirmware\b", 4),
        (r"\bmicrocontrollers?\b", 3), (r"\bPCB\b|printed circuit boards?", 3),
        (r"\bAltium\b|\bKiCad\b", 3), (r"\bsensors?\b", 2), (r"motor control", 2),
        (r"\bmechatronics\b", 4), (r"\bRTOS\b", 3), (r"\bROS\b|\bROS2\b", 1),
    ],
    "power": [
        (r"power electronics", 6), (r"power systems?|power grids?|power engineering", 5),
        (r"\bbatter(?:y|ies)\b", 3), (r"\binverters?\b", 4), (r"\bDC[ -]DC\b", 4),
        (r"power converters?", 4), (r"electrical power", 4), (r"battery management|\bBMS\b", 4),
        (r"motor drives?", 4), (r"renewable energy", 3), (r"high[ -]voltage", 3),
        (r"\bsubstations?\b", 3), (r"power distribution", 3),
    ],
}
TECHNOLOGY_PATTERNS = {
    "FPGA": r"\bFPGA\b", "RTL": r"\bRTL\b", "Verilog": r"\bVerilog\b",
    "SystemVerilog": r"\bSystemVerilog\b", "VHDL": r"\bVHDL\b", "UVM": r"\bUVM\b",
    "Vivado": r"\bVivado\b", "Quartus": r"\bQuartus\b", "Altium": r"\bAltium\b",
    "KiCad": r"\bKiCad\b", "PCB": r"\bPCB\b|printed circuit board", "C++": r"\bC\+\+",
    "C": r"\bC(?:\s+programming|\s*/\s*C\+\+)|(?<!\w)C(?!\+|\w)",
    "Python": r"\bPython\b", "MATLAB": r"\bMATLAB\b", "Simulink": r"\bSimulink\b",
    "SPICE": r"\b(?:LT)?SPICE\b", "ROS": r"\bROS2?\b", "RTOS": r"\bRTOS\b",
    "I2C": r"\bI2C\b|I²C", "SPI": r"\bSPI\b", "UART": r"\bUART\b",
    "CAN": r"\bCAN\s+(?:bus|protocol)\b", "STM32": r"\bSTM32\b",
    "SolidWorks": r"\bSolidWorks\b", "LabVIEW": r"\bLabVIEW\b",
}


def _role(job, body):
    title = _text(job.get("title"))
    employment = _text(job.get("employment_type"))
    internship = None
    if _has(r"\bintern(?:ship)?s?\b|\bco[ -]?op\b", title + " " + employment):
        internship = True
    elif _has(r"(?:this|the|our|an?)\s+(?:\w+\s+){0,2}internship\b|internship (?:position|program|role)", body):
        internship = True
    if _has(r"not (?:an? )?internship|permanent (?:position|role)|\b(?:senior|principal|staff|director|manager)\b", title + " " + employment):
        internship = False

    scores, matches = {}, {}
    for template, terms in TEMPLATE_TERMS.items():
        scores[template], matches[template] = 0, []
        for pattern, weight in terms:
            found = re.search(pattern, body, re.I)
            if found:
                scores[template] += weight
                matches[template].append(found.group(0))
            if _has(pattern, title):
                scores[template] += weight * 2
    ranked = sorted(scores, key=lambda key: scores[key], reverse=True)
    selected = ranked[0] if scores[ranked[0]] else "robotics"
    weak = scores[selected] < 4 or scores[ranked[0]] == scores[ranked[1]]
    generic_hardware = r"\bhardware\b|electrical engineering|electronics? engineering|\bcircuit(?:ry|s)?\b|\bfirmware\b|\bembedded\b|\bFPGA\b|\bASIC\b|\bRTL\b|\bPCB\b|printed circuit|power electronics|power systems?|\bmicrocontrollers?\b|\bmechatronics\b"
    hardware = True if _has(generic_hardware, body) or _has(r"\belectrical\b|\belectronics?\b", title) else None
    nonhardware = _has(r"\b(?:marketing|sales|accounting|finance|legal|HR|human resources|recruiting|business development|graphic design)\b", title)
    software = _has(r"\bsoftware\b|machine learning|data scien(?:ce|tist)", title)
    if nonhardware:
        hardware = False
    elif software and not _has(r"embedded|firmware|\bFPGA\b|\bRTL\b", title):
        hardware = None if hardware else False
    elif not hardware and scores["power"] >= 4:
        hardware = True
    reason = f"{selected}: " + (", ".join(matches[selected]) if matches[selected] else "no specific specialization found")
    if weak:
        reason += "; weak or tied match requires review"
    technologies = [name for name, pattern in TECHNOLOGY_PATTERNS.items() if _has(pattern, body)]
    return internship, hardware, selected, reason, weak, technologies


US_STATE_CODES = r"AL|AK|AZ|AR|CA|CO|CT|DE|FL|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC"
FOREIGN = r"\b(?:Canada|United Kingdom|UK|England|Scotland|Germany|France|India|China|Japan|Australia|Singapore|Netherlands|Ireland|Israel|Switzerland|Sweden|Norway|Denmark|Spain|Italy|Mexico|Brazil|Taiwan|South Korea|Poland|Belgium|Austria|Finland|New Zealand|Hong Kong|UAE|United Arab Emirates)\b"


def _location(job, target):
    location = _text(job.get("location"))
    country = _text(job.get("country") or job.get("country_code"))
    us_explicit = _has(r"\bUnited States(?: of America)?\b|\bUSA\b|\bU\.S\.(?:A\.)?", location + " " + country) or bool(re.search(r"\bUS\b", location))
    if country.upper() in ("US", "USA"):
        us_explicit = True
    foreign_explicit = _has(FOREIGN, location + " " + country) or bool(country and country.upper() not in ("US", "USA") and not _has(r"United States", country))
    if str(target).upper() not in ("US", "USA", "UNITED STATES"):
        return None  # This version intentionally implements the agreed U.S. scope.
    if us_explicit:
        return True
    if foreign_explicit:
        return False
    # Comma-prefixed state codes disambiguate most two-letter country names.
    if re.search(rf",\s*(?:{US_STATE_CODES})(?:\s+\d{{5}})?(?:\b|$)", location):
        return True
    states = "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming"
    if _has(rf"\b(?:{states})\b", location):
        return True
    if _has(r"\b(?:San Francisco|San Jose|San Diego|Los Angeles|Seattle|Boston|Austin|Houston|Dallas|Atlanta|Pittsburgh|Philadelphia|Chicago|Tampa|Orlando|Phoenix|Portland|Raleigh|Santa Clara|Sunnyvale|Cupertino)\b", location):
        return True
    return None


def _term(job, config):
    target_year = int(config.get("target_year", 2027))
    target_season = str(config.get("target_season", "summer")).lower().replace("autumn", "fall")
    # A structured list describes available internship terms, not publication dates.
    # Match complete term pairs so Summer 2026 + Fall 2027 is not Summer 2027.
    source_terms = job.get("source_terms") or []
    if isinstance(source_terms, str):
        source_terms = [source_terms]
    if source_terms:
        # An aggregator term must not override a conflicting current employer title.
        title = _text(job.get("title"))
        employer_pairs = re.findall(r"\b(summer|fall|autumn|winter|spring)\s+(?:of\s+)?(20\d{2})\b", title, re.I)
        if employer_pairs and any((int(year), season.lower().replace("autumn", "fall")) != (target_year, target_season)
                                  for season, year in employer_pairs):
            return None, None
    term_pairs = []
    for term in source_terms:
        term_years = re.findall(r"\b20\d{2}\b", _text(term))
        term_seasons = re.findall(r"\b(summer|fall|autumn|winter|spring)\b", _text(term), re.I)
        if len(term_years) == 1 and len(term_seasons) == 1:
            term_pairs.append((int(term_years[0]), term_seasons[0].lower().replace("autumn", "fall")))
    if (target_year, target_season) in term_pairs:
        return True, True
    if term_pairs and len(term_pairs) == len(source_terms):
        # Excluding the offered term is justified even when target year and season
        # occur separately in different alternatives.
        matching_years = [season for year, season in term_pairs if year == target_year]
        return (True, False) if matching_years else (False, None)
    years, seasons = set(), set()
    structured = job.get("structured_term") or {}
    if not isinstance(structured, dict):
        structured = {}
    year = job.get("internship_year", job.get("target_year", structured.get("year")))
    if year is not None and re.fullmatch(r"20\d{2}", str(year)):
        years.add(int(year))
    season = job.get("internship_season", job.get("target_season", structured.get("season")))
    if season and str(season).lower() in ("summer", "fall", "autumn", "winter", "spring"):
        seasons.add(str(season).lower().replace("autumn", "fall"))
    start = job.get("start_date") or structured.get("start_date")
    if start:
        try:
            start = date.fromisoformat(str(start)[:10])
            years.add(start.year)
            seasons.add("summer" if 5 <= start.month <= 8 else "spring" if 1 <= start.month <= 4 else "fall" if 9 <= start.month <= 11 else "winter")
        except ValueError:
            pass
    title = _text(job.get("title"))
    explicit_term = _text(job.get("internship_term") or job.get("term"))
    for text in (title, explicit_term):
        for match in re.finditer(r"\b20\d{2}\b", text):
            if not _has(r"graduat|class of", text[max(0, match.start() - 40):match.start()]):
                years.add(int(match.group(0)))
        seasons.update(match.lower().replace("autumn", "fall") for match in re.findall(r"\b(summer|fall|autumn|winter|spring)\b", text, re.I))
    for sentence in _sentences(_text(job.get("description"))):
        # Graduation, application deadlines, and posting dates do not date the job.
        for match in re.finditer(r"\b(summer|fall|autumn|winter|spring)\s+(?:of\s+)?(20\d{2})\b|\b(20\d{2})\s+(summer|fall|autumn|winter|spring)\b", sentence, re.I):
            before = sentence[max(0, match.start() - 45):match.start()]
            if _has(r"graduat|class of|deadline|posted|appl(?:y|ication)s? (?:by|close)", before):
                continue
            matched_season, matched_year = (match.group(1), match.group(2)) if match.group(1) else (match.group(4), match.group(3))
            seasons.add(matched_season.lower().replace("autumn", "fall"))
            years.add(int(matched_year))
        for match in re.finditer(r"\b(summer|fall|autumn|winter|spring)\b", sentence, re.I):
            neighborhood = sentence[max(0, match.start() - 35):match.end() + 35]
            if _has(r"internship|\bintern\b|program|placement|assignment|starts?|begins?", neighborhood) and not _has(r"graduat|class of", neighborhood):
                seasons.add(match.group(1).lower().replace("autumn", "fall"))
    target_season = target_season.replace("autumn", "fall")
    year_match = None if not years or len(years) > 1 else target_year in years
    season_match = None if not seasons or len(seasons) > 1 else target_season in seasons
    return year_match, season_match


def classify_job(job, config=None):
    """Return a copy of a listing with evidence, resume choice, and queue decision.

    Structured authorization booleans must be sourced from employer/portal data,
    never inferred from a missing restriction. Their evidence strings identify the
    exact input fields. Text evidence remains verbatim. Unknowns remain reviewable.
    """
    config = config or {}
    result = dict(job)
    body = _text(job.get("title")) + "\n" + _text(job.get("description"))
    eligibility, contradictory, export_review = _authorization(job, body)
    internship, hardware, template, template_reason, weak, technologies = _role(job, body)
    location = _location(job, config.get("target_country", "US"))
    year, season = _term(job, config)
    excluded, review = [], []
    if not _text(job.get("description")).strip():
        review.append("Full job description is missing")
    elif job.get("description_is_summary"):
        review.append("Full job description is needed; source provided only a summary")
    checks = [
        (internship, "Role is explicitly outside internship scope", "Internship status is not explicit"),
        (hardware, "Role is outside hardware scope", "Hardware responsibilities need review"),
        (location, "Location is outside the configured country", "U.S. location is not explicit"),
        (year, "Internship year differs from the target", "Internship year is missing or ambiguous"),
        (season, "Internship season differs from the target", "Internship season is missing or ambiguous"),
    ]
    for status, exclusion, uncertainty in checks:
        if status is False:
            excluded.append(exclusion)
        elif status is None:
            review.append(uncertainty)
    if eligibility["category"] == "discarded":
        excluded.append("Explicit international-student or citizenship restriction")
    elif contradictory:
        review.append("Contradictory work-authorization statements require review")
    elif eligibility["status"] == "unknown" and config.get("require_explicit_authorization", True):
        review.append("No explicit CPT/OPT or international-student acceptance")
    if export_review:
        review.append("Export-control or clearance conditions require review")
    if weak:
        review.append("Resume specialization is weak or tied")
    result.update(
        eligibility=eligibility,
        template=template,
        template_reason=template_reason,
        technologies=technologies,
        decision="excluded" if excluded else "review" if review else "eligible",
        reasons=excluded + review,
        is_internship=internship,
        is_hardware=hardware,
    )
    return result
