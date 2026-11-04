#!/usr/bin/env python3
"""
Generate a SALT survey import bundle (schema_version 1) from the
CRANE 4 SURVEY - Short MSM Word document (Version Date 11 Nov 2025).

See salt_management/SURVEY_IMPORT_EXPORT.md for the bundle contract.

Conventions applied here:
  - JEXL multiple_choice answers are 0-based OPTION INDICES (verified in
    SurveyViewModel.buildJexlContext / Answer.getValue). The docx codes in
    opts are kept for reference only; SALT has no field for them.
  - pre_script is SKIP-IF: true => question hidden.
  - Computed/hidden docx fields (TUTDOB, ALCSCR1/2, PHQSUM/SCRE, BMHIV, TSTAT)
    are dropped; SALT has no computed question type.
  - Biomarkers: 4 rapid tests in test_configurations; CD4 & viral load are
    deployment-global lab tests, configured separately (not in the bundle).
"""
import json
import datetime
import os

LANG = "English"
SEC_ELIG = 1
SEC_MAIN = 2


def tj(text):
    """Multilingual text object, serialised as a JSON *string*."""
    return json.dumps({LANG: text}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Question specifications, in survey order.
#   sec : 'e' (Eligibility) | 'm' (Main)
#   t   : multiple_choice | multi_select | numeric | text | info
#   opts: list of [docx_code, option_text]
#   pre : pre_script (skip-if JEXL)
#   vs  : validation_script ; ve : validation error text
#   minsel/maxsel : multi_select bounds
# ---------------------------------------------------------------------------
Q = [
    # ===================== ELIGIBILITY (staff-screened) =====================
    dict(sn="TUTSEX", sec="e", t="multiple_choice",
         text="Were you born female or male?",
         opts=[["1", "Female"], ["2", "Male"]]),
    dict(sn="TUTAGE", sec="e", t="numeric",
         text="How old are you?",
         vs="value >= 15 && value <= 89",
         ve="Please enter an age between 15 and 89."),
    dict(sn="ELTGSX", sec="e", t="multiple_choice",
         text="Have you ever had sex? By sex, we mean either vaginal sex or "
              "anal sex. With vaginal sex we mean a penis enters a vagina. "
              "With anal sex we mean a penis enters a person's anus.",
         opts=[["1", "Yes"], ["2", "No"]]),
    dict(sn="ELMSSXT", sec="e", t="multiple_choice",
         text="How long ago did you last have anal sex with a man?",
         opts=[["1", "Within the last 6 months"],
               ["2", "More than 6 months ago"],
               ["7", "Don't know"]],
         pre="ELTGSX != 0"),
    dict(sn="ELCOUP", sec="e", t="multiple_choice",
         text="Choose the response that best describes who or how you got "
              "the coupon that you are using to participate in the survey.",
         opts=[["1", "Friend"], ["2", "Family member"], ["3", "Stranger"],
               ["4", "Found it"], ["7", "Bought the coupon"]],
         pre="ELMSSXT != 0"),

    # ============================== MAIN ===================================
    dict(sn="TUTMSS", sec="m", t="info",
         text="Welcome to the interview. It is simple and short. You can "
              "listen to and read the questions. To answer, you simply touch "
              "the answer that fits "
              "best. Please answer all questions; there are no \"right\" or "
              "\"wrong\" answers. If you want to go back to the previous "
              "question, simply touch the \"BACK\" button. If you have any "
              "problem during the interview, just call our staff. Please "
              "touch the NEXT button to continue."),
    dict(sn="TUTEDU", sec="m", t="multiple_choice",
         text="What is the highest level of school education you have "
              "received?",
         opts=[["1", "Never went to school"], ["2", "Some primary"],
               ["3", "Completed primary"], ["4", "Some secondary"],
               ["5", "Completed secondary or higher"]]),

    # ---- Personal network size (DG) ----
    dict(sn="DG1MSG", sec="m", t="info",
         text="Now I am going to ask you a few questions about how many "
              "people you know."),
    dict(sn="DGBEHAV", sec="m", t="numeric",
         text="How many people do you know who have had anal sex with "
              "another man? By \"know\", we mean you know this person's name "
              "and they know your name.",
         vs="value >= 1",
         ve="Please enter a number of 1 or more."),
    dict(sn="DGAGE", sec="m", t="numeric",
         text="Of the people you mentioned, how many are aged 18 or older?",
         vs="value >= 0 && value <= DGBEHAV",
         ve="This number cannot be larger than the number of people you "
            "reported knowing."),
    dict(sn="DGSEEN", sec="m", t="numeric",
         text="Of the people aged 18 or older that you mentioned, how many "
              "have you seen in the last 14 days?",
         vs="value >= 0 && value <= DGAGE",
         ve="This number cannot be larger than the number you gave in the "
            "previous question."),

    # ---- Demographics (DM) ----
    dict(sn="TUTNAT", sec="m", t="multiple_choice",
         text="What is your nationality?",
         opts=[["1", "Ugandan"], ["2", "Other"]]),
    dict(sn="DEMARSTA", sec="m", t="multiple_choice",
         text="What is your current marital status?",
         opts=[["1", "Single, never married"], ["2", "Married"],
               ["3", "Separated/divorced"], ["4", "Widowed"],
               ["7", "Don't know"], ["8", "Prefer not to answer"]]),

    # ---- Sexual history ----
    dict(sn="NRPT", sec="m", t="numeric",
         text="In the past six months, with how many men have you had anal "
              "sex? With anal sex, I mean a penis enters a person's anus. "
              "Please give your best guess.",
         vs="value >= 1 && value <= 95",
         ve="Please enter a number between 1 and 95."),
    dict(sn="Cond", sec="m", t="multiple_choice",
         text="Think about the last time you had anal sex with another man. "
              "Did you use a condom? By anal sex, I mean a penis enters a "
              "person's anus.",
         opts=[["1", "Yes"], ["2", "No"], ["3", "Don't know"],
               ["7", "Refused to answer"]]),
    dict(sn="CONDNO", sec="m", t="multiple_choice",
         text="Why didn't you use a condom the last time you had anal sex "
              "with another man? By anal sex, I mean a penis enters a "
              "person's anus.",
         opts=[["1", "I was using PrEP"], ["2", "I am virally suppressed"],
               ["3", "I am on HIV treatment"], ["4", "Other"],
               ["5", "Don't know"], ["6", "Refused to answer"]],
         pre="Cond != 1"),
    dict(sn="TrSex", sec="m", t="multiple_choice",
         text="Did you ever have anal sex with another man for money, gifts, "
              "or other support or help? Do not count your spouse or "
              "partner. By anal sex, I mean a penis enters a person's anus.",
         opts=[["1", "Yes"], ["2", "No"]]),
    dict(sn="SVCEVFR", sec="m", t="numeric",
         text="In your lifetime, how many times has anyone ever tricked you, "
              "lied to you, or threatened you in order to make you have sex "
              "with them when you didn't want to?",
         vs="value >= 0 && value <= 99",
         ve="Please enter a number between 0 and 99."),
    dict(sn="SVREVFR", sec="m", t="numeric",
         text="In your lifetime, how many times has anyone ever physically "
              "forced you to have sex when you didn't want to?",
         vs="value >= 0 && value <= 99",
         ve="Please enter a number between 0 and 99."),

    # ---- Alcohol (AUDIT-C) ----
    dict(sn="ALCMSS", sec="m", t="info",
         text="Thank you. The next few questions are about alcohol. Please "
              "touch \"NEXT\"."),
    dict(sn="ALCFREQ", sec="m", t="multiple_choice",
         text="Now I am going to ask you some questions about your use of "
              "alcohol during the last 12 months. How often do you have a "
              "drink containing alcohol?",
         opts=[["0", "Never"], ["1", "Monthly or less"],
               ["2", "2-4 times a month"], ["3", "2-3 times a week"],
               ["4", "4 or more times a week"]]),
    dict(sn="ALCDAY", sec="m", t="multiple_choice",
         text="How many drinks containing alcohol do you have on a typical "
              "day when you are drinking? For example, one bottle of beer or "
              "one sachet of Waragi counts as two drinks.",
         opts=[["0", "One or less"], ["1", "About two"],
               ["2", "About three"], ["3", "About four"],
               ["4", "Five or more"]],
         pre="ALCFREQ == 0"),
    dict(sn="ALCBINGE", sec="m", t="multiple_choice",
         text="How often do you have three or more drinks on one occasion? "
              "For example, one bottle of beer or one sachet of Waragi "
              "counts as one drink.",
         opts=[["0", "Never"], ["1", "Less than monthly"], ["2", "Monthly"],
               ["3", "Weekly"], ["4", "Daily or almost daily"]],
         pre="ALCFREQ == 0"),

    # ---- Injection drug use (DR) ----
    dict(sn="DRMSS", sec="m", t="info",
         text="Thank you. Now some questions about drugs. People sometimes "
              "take drugs to feel better or get high. Such drugs include, "
              "for example, marijuana, amphetamines, ecstasy, opiates, "
              "cocaine, or sleep medications such as valium. I do not mean "
              "cigarettes, alcohol, or medicine you take when you are ill. "
              "People can swallow, sniff, smoke, or inject drugs with a "
              "needle. Please touch \"NEXT\" to start."),
    dict(sn="ELINJ", sec="m", t="multiple_choice",
         text="Have you ever in your life shot up or injected any drugs "
              "other than those recommended or given by a health care "
              "worker? By shooting up, I mean any time you might have used "
              "drugs with a needle, either by mainlining, skin popping, or "
              "muscling.",
         opts=[["1", "Yes"], ["2", "No"], ["3", "Don't know"],
               ["4", "Refused to answer"]]),
    dict(sn="DRSHARE", sec="m", t="multiple_choice",
         text="Have you ever shared needles or syringes?",
         opts=[["1", "Yes, in the last 6 months"],
               ["2", "Yes, but more than 6 months ago"],
               ["3", "Never shared needles or syringes"]],
         pre="ELINJ != 0"),

    # ---- Depression (PHQ-2) ----
    dict(sn="PHQMSS", sec="m", t="info",
         text="Thank you. Now two questions about how you feel. Touch "
              "\"NEXT\"."),
    dict(sn="PHQ1", sec="m", t="multiple_choice",
         text="Over the past two weeks, how often have you been bothered by "
              "having little interest or pleasure in doing things?",
         opts=[["0", "Not at all"], ["1", "Several days"],
               ["2", "More than half the days"], ["3", "Nearly every day"]]),
    dict(sn="PHQ2", sec="m", t="multiple_choice",
         text="Over the past two weeks, how often have you been bothered by "
              "feeling down, depressed, or hopeless?",
         opts=[["0", "Not at all"], ["1", "Several days"],
               ["2", "More than half the days"], ["3", "Nearly every day"]]),
    dict(sn="MHYS", sec="m", t="multiple_choice",
         text="Have you ever harmed yourself?",
         opts=[["1", "Yes"], ["2", "No"]]),

    # ---- Service uptake (OUT / TS / ART / UU / PR / TB) ----
    dict(sn="HCMSS", sec="m", t="info",
         text="Thank you. Now a few questions about health care. Please "
              "touch \"NEXT\"."),
    dict(sn="STGDENY", sec="m", t="multiple_choice",
         text="In the last 12 months, I have felt that a healthcare provider "
              "denied me services because of having sex with men.",
         opts=[["1", "Never"], ["2", "Once"], ["3", "A few times"],
               ["4", "Often"],
               ["5", "Does not apply because no one knows I have sex with "
                     "men"],
               ["7", "Don't know"], ["8", "Prefer not to answer"]]),
    dict(sn="HCTELL", sec="m", t="multiple_choice",
         text="When asked, are you comfortable telling a health care "
              "provider that you have sex with men?",
         opts=[["1", "Yes"], ["2", "No"]]),
    dict(sn="STGAVOID", sec="m", t="multiple_choice",
         text="In the last 12 months, I have avoided seeking health or "
              "social services because I worried I may be discriminated "
              "against because I have sex with men.",
         opts=[["1", "Never"], ["2", "Once"], ["3", "A few times"],
               ["4", "Often"],
               ["5", "Does not apply because no one knows I have sex with "
                     "men"],
               ["7", "Don't know"], ["8", "Prefer not to answer"]]),
    dict(sn="CSONLINE", sec="m", t="multiple_choice",
         text="Have you ever accessed information or services related to HIV "
              "or sexual health online?",
         opts=[["1", "Never"], ["2", "Once"], ["3", "A few times"],
               ["4", "Often"]]),
    dict(sn="OUTEXP", sec="m", t="multiple_choice",
         text="Have any outreach workers or peer educators talked to you "
              "about HIV/STI prevention?",
         opts=[["1", "Yes, in the last 6 months"],
               ["2", "Yes, but more than 6 months ago"], ["3", "Never"]]),
    dict(sn="TSEVER", sec="m", t="multiple_choice",
         text="Have you ever tested for HIV?",
         opts=[["1", "Yes"], ["2", "No"]]),
    dict(sn="TSEVNO", sec="m", t="multiple_choice",
         text="Why have you never tested? Please select the best answer.",
         opts=[["1", "I don't feel at risk"],
               ["2", "I fear testing positive"],
               ["3", "I fear stigma by a health care provider"],
               ["4", "I fear others may learn my result"]],
         pre="TSEVER != 1",
         # Never-testers: route into the PrEP block (past the HIV-positive
         # ART/UU track). PRWANT then sends them on, skipping TB.
         skipscript="TSEVER == 1", skiptarget="PRMSS"),
    dict(sn="TSETWLMTH", sec="m", t="multiple_choice",
         text="Have you tested for HIV in the past 12 months?",
         opts=[["1", "Yes"], ["2", "No"]],
         pre="TSEVER != 0"),
    dict(sn="TS1YRNO", sec="m", t="multiple_choice",
         text="Why have you not tested in the last 12 months? Please select "
              "the best answer.",
         opts=[["1", "I don't feel at risk"],
               ["2", "I fear testing positive"],
               ["3", "I fear stigma by a health care provider"],
               ["4", "I fear others may learn my result"],
               ["5", "I already know I am positive"]],
         pre="TSETWLMTH != 1"),
    dict(sn="TSRES", sec="m", t="multiple_choice",
         text="Before today, what was your last HIV test result?",
         opts=[["1", "Positive"], ["2", "Negative"], ["995", "I don't know"]],
         pre="TSEVER != 0"),
    dict(sn="TSPROVPOS", sec="m", t="multiple_choice",
         text="Has a health care provider ever told you that you have HIV?",
         opts=[["1", "Yes"], ["2", "No"]],
         pre="TSEVER != 0 || TSRES == 0",
         # Not provider-positive -> leave the HIV-positive ART/UU track.
         skipscript="TSPROVPOS != 0", skiptarget="PRMSS"),

    # ---- ART / UU / TB (self-reported HIV-positive) ----
    # These blocks are reached ONLY by HIV-positive respondents: non-positive
    # testers jump to PRMSS via TSPROVPOS, never-testers jump to PRMSS via
    # TSEVNO. So no outer HIV-status gate is repeated here - the only
    # pre_scripts left are genuine per-question dependencies.
    dict(sn="ARTMSG", sec="m", t="info",
         text="Now some questions on anti-retroviral treatment, also called "
              "ART or ARVs, to treat HIV."),
    dict(sn="ARTEVR", sec="m", t="multiple_choice",
         text="Have you ever taken ARVs for HIV treatment?",
         opts=[["1", "Yes"], ["2", "No"]]),
    dict(sn="ARTNOW", sec="m", t="multiple_choice",
         text="Do you take ARVs now for treatment?",
         opts=[["1", "Yes"], ["2", "No"]],
         pre="ARTEVR != 0"),
    dict(sn="ARTPROV", sec="m", t="multiple_choice",
         text="Where do you get your ARVs from?",
         opts=[["1", "Directly at a hospital or clinic"],
               ["2", "At an NGO with services for people like me"],
               ["3", "At a drop-in centre"],
               ["4", "At a pharmacy or drug shop"], ["96", "Other"]],
         pre="ARTNOW != 0"),
    dict(sn="ARTDUP", sec="m", t="multiple_choice",
         text="People sometimes collect their ARVs from several places. Do "
              "you collect ARVs from multiple places?",
         opts=[["1", "Yes"], ["2", "No"]],
         pre="ARTNOW != 0"),

    # ---- Viral load & U=U (self-reported HIV-positive) ----
    dict(sn="UUVLTEST", sec="m", t="multiple_choice",
         text="Have you been tested for viral load?",
         opts=[["1", "Yes, in the last 12 months"],
               ["2", "Yes, but more than 12 months ago"],
               ["3", "Never tested for viral load"],
               ["995", "Don't know / don't remember"]],
         pre="ARTNOW != 0"),
    dict(sn="CSVLRS1", sec="m", t="multi_select",
         text="Was your last viral load test \"Suppressed\" or \"Not "
              "suppressed\"/\"Unsuppressed\"? Viral load results can be "
              "\"Suppressed,\" \"Undetectable,\" \"Not suppressed,\" or "
              "\"Unsuppressed.\" Suppressed means there is very low or no "
              "virus in your blood. Undetectable means there is so little "
              "virus that the test cannot measure it. Not suppressed or "
              "unsuppressed means there is still plenty of virus in your "
              "blood. Select all that apply.",
         opts=[["1", "Suppressed"], ["2", "Undetectable"],
               ["3", "Not suppressed/unsuppressed"],
               ["4", "They did not tell me the result"],
               ["7", "Don't know"], ["8", "Prefer not to answer"]],
         minsel=1,
         pre="ARTNOW != 0 || (UUVLTEST != 0 && UUVLTEST != 1)"),
    dict(sn="UUVLRES", sec="m", t="multiple_choice",
         text="Did you understand your last viral load result?",
         opts=[["1", "I understood my viral load result"],
               ["2", "I did not understand my result"],
               ["3", "I did not get the result"],
               ["995", "I don't know or don't remember"]],
         pre="ARTNOW != 0 || UUVLTEST == 2 || UUVLTEST == 3"),
    dict(sn="UUKNOW", sec="m", t="multiple_choice",
         text="A question about viral load: have you heard of U=U, or "
              "Undetectable = Untransmittable?",
         opts=[["1", "Yes"], ["2", "No"], ["3", "Not sure"]]),
    dict(sn="UUBEL", sec="m", t="multiple_choice",
         text="U=U means someone taking ARVs can have very little or no HIV "
              "in their blood. It means that they cannot pass HIV on to "
              "others, even without using condoms or PrEP. How true do you "
              "believe U=U to be?",
         opts=[["1", "It's true"], ["2", "I'm not sure if it's true"],
               ["3", "It's not true"]],
         # End of the HIV-positive ART/UU run: skip PrEP, go to TB.
         skipscript="TSRES == 0 || TSPROVPOS == 0", skiptarget="TBMSS"),

    # ---- PrEP (HIV-negative testers and never-testers) ----
    # Reached via TSPROVPOS's skip_to (non-provider-positive testers) and via
    # TSEVNO's skip_to (never-testers). PRMSS routes "don't know" testers
    # onward; HIV-negative testers and never-testers do the full PrEP run.
    dict(sn="PRMSS", sec="m", t="info",
         text="Thank you. Now we will ask some questions about pre-exposure "
              "prophylaxis, also called PrEP. PrEP is a medicine that can "
              "prevent HIV. It is taken by HIV-negative people.",
         # Last HIV test result "don't know" -> status unknown: skip PrEP.
         skipscript="TSRES == 2", skiptarget="STDIAG"),
    dict(sn="PPRKNOW", sec="m", t="multiple_choice",
         text="Have you heard of PrEP?",
         opts=[["1", "Yes"], ["2", "No"], ["3", "Don't know"],
               ["4", "Prefer not to answer"]]),
    dict(sn="PROFFER", sec="m", t="multiple_choice",
         text="Has a health care provider offered you PrEP?",
         opts=[["1", "Yes"], ["2", "No"]],
         pre="PPRKNOW != 0"),
    dict(sn="PRGET", sec="m", t="multiple_choice",
         text="Do you know where to get PrEP?",
         opts=[["1", "Yes"], ["2", "No"]],
         pre="PPRKNOW != 0"),
    dict(sn="PRTAKE", sec="m", t="multiple_choice",
         text="Have you used PrEP?",
         opts=[["1", "Yes, in the last 7 days"],
               ["2", "Yes, in the last 6 months"],
               ["3", "Yes, more than 6 months ago"],
               ["4", "No, I have never taken PrEP"]],
         pre="PPRKNOW != 0"),
    dict(sn="PRWANT", sec="m", t="multiple_choice",
         text="Do you want to use PrEP?",
         opts=[["1", "Yes"], ["2", "No"], ["995", "Don't know"]],
         # End of the PrEP run (HIV-negative testers + never-testers): skip TB.
         skipscript="TSRES == 1 || TSEVER == 1", skiptarget="STDIAG"),

    # ---- TB (self-reported HIV-positive) ----
    # Reached only via UUBEL's skip_to.
    dict(sn="TBMSS", sec="m", t="info",
         text="Thank you. Now some questions about TB."),
    dict(sn="TBSCRNP", sec="m", t="multiple_choice",
         text="After you tested HIV-positive, did they ask you about TB "
              "symptoms? With symptoms, I mean a long-standing cough, night "
              "sweats, fever, and weight loss.",
         opts=[["1", "Yes, I was asked about TB symptoms"],
               ["2", "No, I was not asked"], ["3", "I don't remember"]]),
    dict(sn="TBDX", sec="m", t="multiple_choice",
         text="Did a health care provider tell you that you have TB?",
         opts=[["1", "No one talked to me about TB"],
               ["2", "The provider told me I have TB"],
               ["3", "The provider told me I do not have TB"]]),
    dict(sn="TBPT", sec="m", t="multiple_choice",
         text="Did they give you TB drugs to prevent TB disease?",
         opts=[["1", "Yes"], ["2", "No"]],
         pre="TBDX != 2"),
    dict(sn="TBTX", sec="m", t="multiple_choice",
         text="Were you treated for TB?",
         opts=[["1", "Yes"], ["2", "No"]],
         pre="TBDX != 1"),

    # ---- Sexually transmitted infections (ST) ----
    dict(sn="STDIAG", sec="m", t="multiple_choice",
         text="In the last 12 months, did a healthcare provider tell you "
              "that you had a sexually transmitted infection, other than "
              "HIV?",
         opts=[["1", "Yes"], ["2", "No"], ["7", "Don't know"],
               ["8", "Prefer not to answer"]]),
]

# ---------------------------------------------------------------------------
# Build the bundle
# ---------------------------------------------------------------------------
questions = []
options = []
qid = 100

for idx, spec in enumerate(Q):
    qid += 1
    q = {
        "id": qid,
        "question_index": idx,
        # short_names (and every JEXL reference to them) are lower-cased.
        "short_name": spec["sn"].lower(),
        "question_type": spec["t"],
        "question_text_json": tj(spec["text"]),
        "section_id": SEC_ELIG if spec["sec"] == "e" else SEC_MAIN,
    }
    if spec.get("pre"):
        q["pre_script"] = spec["pre"].lower()
    if spec.get("skipscript"):
        q["skip_to_script"] = spec["skipscript"].lower()
        q["skip_to_target"] = spec["skiptarget"].lower()
    if spec.get("vs"):
        # In a validation_script the answer being validated is bound to
        # `value` (also available under the question's own short_name).
        q["validation_script"] = spec["vs"].lower()
        q["validation_error_json"] = tj(spec["ve"])
    if spec["t"] == "multi_select":
        q["min_selections"] = spec.get("minsel")
        q["max_selections"] = spec.get("maxsel")
    questions.append(q)

    for oidx, (_code, otext) in enumerate(spec.get("opts", [])):
        options.append({
            "question_id": qid,
            "option_index": oidx,
            "option_text_json": tj(otext),
        })

# ---------------------------------------------------------------------------
# System message texts
# ---------------------------------------------------------------------------
STAFF_VALIDATION_TEXT = "Please hand the tablet to a staff member."

PAYMENT_CONFIRMATION_TEXT = (
    "Thank you for your participation. You will now be paid the amount "
    "below."
)

CONSENT_TEXT = (
    "Written Informed Consent for Participation in Biological and "
    "Behavioral Research on HIV Infection\n\n"
    "This study aims to assess the prevalence of HIV and other infections, "
    "as well as risk behaviors, within the group. The information we "
    "collect will help us implement or strengthen HIV and other infection "
    "prevention programs.\n\n"
    "If you agree to participate in the study, you will need to undergo an "
    "interview and provide a blood sample for testing for HIV, hepatitis B "
    "and C, and syphilis. The interview will take approximately 20-25 "
    "minutes. You can receive your test results and, if necessary, be "
    "referred to the appropriate services. Please be aware that you are "
    "free to discontinue your participation at any time.\n\n"
    "No information that could identify you will be recorded on the "
    "questionnaire or on the specimens. Your honest and direct answers to "
    "our questions are highly valued.\n\n"
    "Having reviewed the information provided to me by the staff conducting "
    "the study, the objectives of the study, as well as the procedures that "
    "the participant must undergo if they consent, I have decided to "
    "participate in the aforementioned research.\n\n"
    "I understand the benefits of participating in the study, as well as "
    "all possible risks and consequences for me. I have been informed that "
    "I may discontinue my participation in the study at any time, without "
    "providing any explanation.\n\n"
    "It has been explained to me that no data identifying me will be "
    "recorded either during the completion of the questionnaire or during "
    "the testing of the blood sample.\n\n"
    "I hereby give my written informed consent to participate in the "
    "research on HIV infection, hepatitis B and C, and syphilis."
)

survey = {
    "name": "Short MSM Survey",
    "version": 1,
    "description": "A short survey for surveying men who have sex with men.",
    "languages": json.dumps([LANG]),
    "eligibility_script": (
        "TUTSEX == 1 && TUTAGE != null && TUTAGE >= 18 && ELTGSX == 0 "
        "&& ELMSSXT == 0 && (ELCOUP == 0 || ELCOUP == 1)"
    ).lower(),
    "eligibility_message_json": tj(
        "The computer has determined that you are not eligible to "
        "participate in the survey. Thank you for your time and interest. "
        "Please contact the survey staff to complete the process."),
    "staff_validation_message_json": tj(STAFF_VALIDATION_TEXT),
    "version_notes": "Generated from 'CRANE 4 SURVEY Short MSM' docx "
                     "(Version Date 11 Nov 2025).",
    "fingerprint_enabled": 0,
    "re_enrollment_days": 90,
    # hiv_rapid_test_enabled drives ONLY the legacy/unused HIVRapidTest screen
    # (dead tech debt). Must stay 0. The four real rapid tests run via the
    # generic test_configurations flow, which does not consult this flag.
    "hiv_rapid_test_enabled": 0,
    "contact_info_enabled": 0,
    "staff_eligibility_screening": 1,
    "rapid_test_samples_after_eligibility": 1,
    "payment_audit_phone_enabled": 0,
}

sections = [
    {"id": SEC_ELIG, "section_index": 0, "section_type": "eligibility",
     "name": "Eligibility",
     "description": "Staff-completed eligibility screening "
                    "(sex, age, sexual history, coupon source)."},
    {"id": SEC_MAIN, "section_index": 1, "section_type": "main",
     "name": "Main",
     "description": "Main CRANE 4 questionnaire, completed by the "
                    "participant via ACASI."},
]

survey_messages = [
    {"message_key": "eligibility_not_eligible",
     "message_text_json": tj(
         "The computer has determined that you are not eligible to "
         "participate in the survey. Thank you for your time and interest. "
         "Please contact the survey staff to complete the process."),
     "audio_files_json": "{}", "message_type": "system", "display_order": 0},
    {"message_key": "consent_agreement",
     "message_text_json": tj(CONSENT_TEXT),
     "audio_files_json": "{}", "message_type": "confirmation",
     "display_order": 0},
    {"message_key": "staff_validation",
     "message_text_json": tj(STAFF_VALIDATION_TEXT),
     "audio_files_json": "{}", "message_type": "instruction",
     "display_order": 0},
    {"message_key": "payment_confirmation",
     "message_text_json": tj(PAYMENT_CONFIRMATION_TEXT),
     "audio_files_json": "{}", "message_type": "confirmation",
     "display_order": 0},
    {"message_key": "coupon_instructions",
     "message_text_json": tj(
         "These coupons are invitations to participate in this study and "
         "can only be used once. Please hand these to any men at least 18 "
         "years old who have sex with other men and you know relatively "
         "well. Please do not give coupons to strangers or attempt to sell "
         "them."),
     "audio_files_json": "{}", "message_type": "instruction",
     "display_order": 0},
]

# Rapid tests carried in the bundle. test_id is a free-form string keying
# the result row and an optional "<test_id>_rapid_test_instruction" message;
# the tablet renders any configured test generically.
test_configurations = [
    {"test_id": "hivrapid", "test_name": "HIV Rapid Test",
     "enabled": 1, "display_order": 0},
    {"test_id": "syprapid", "test_name": "Syphilis Rapid Test",
     "enabled": 1, "display_order": 1},
]

bundle = {
    "schema_version": 1,
    "exported_at": datetime.datetime.utcnow().isoformat() + "Z",
    "source": {
        "survey_name": survey["name"],
        "survey_version": survey["version"],
        "host": "generated-from-docx",
    },
    "survey": survey,
    "sections": sections,
    "questions": questions,
    "options": options,
    "survey_messages": survey_messages,
    "test_configurations": test_configurations,
}

# Written into salt_management/scripts/ so the Docker image ships it and
# init-database.js seeds it into a fresh database on first launch.
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "salt_management", "scripts", "crane4_short_msm_survey.json")
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(bundle, fh, indent=2, ensure_ascii=False)

print(f"Wrote {OUT}")
print(f"  sections:            {len(sections)}")
print(f"  questions:           {len(questions)}  "
      f"(eligibility {sum(1 for q in questions if q['section_id'] == SEC_ELIG)}, "
      f"main {sum(1 for q in questions if q['section_id'] == SEC_MAIN)})")
print(f"  options:             {len(options)}")
print(f"  survey_messages:     {len(survey_messages)}")
print(f"  test_configurations: {len(test_configurations)}")
by_type = {}
for q in questions:
    by_type[q["question_type"]] = by_type.get(q["question_type"], 0) + 1
print(f"  question types:      {by_type}")
