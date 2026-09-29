import unittest

from job_logic import classify_job


class ClassificationTests(unittest.TestCase):
    def job(self, **changes):
        job = {
            "company": "Example Devices",
            "title": "FPGA Engineering Intern - Summer 2027",
            "location": "San Jose, CA",
            "description": "Build RTL and verify Verilog designs. We accept students on CPT or OPT.",
        }
        job.update(changes)
        return job

    def test_qualified_job_has_verbatim_evidence_and_template(self):
        job = self.job()
        result = classify_job(job, {})
        self.assertEqual(result["decision"], "eligible")
        self.assertEqual(result["eligibility"]["status"], "supported")
        self.assertIn("We accept students on CPT or OPT.", result["eligibility"]["evidence"])
        self.assertEqual(result["template"], "fpga")
        self.assertIn("Verilog", result["technologies"])
        self.assertNotIn("decision", job)

    def test_absence_of_restrictions_is_unknown(self):
        result = classify_job(self.job(description="Work on RTL and Verilog."), {})
        self.assertEqual(result["eligibility"]["status"], "unknown")
        self.assertEqual(result["decision"], "review")

    def test_feed_term_does_not_override_conflicting_employer_title(self):
        result = classify_job(self.job(title="FPGA Intern Summer 2026", source_terms=["Summer 2027"]), {})
        self.assertEqual(result["decision"], "review")

    def test_no_sponsorship_does_not_imply_rejection(self):
        for text in (
            "No visa sponsorship is available.",
            "We do not provide sponsorship.",
            "Applicants must be authorized to work in the U.S. without sponsorship.",
        ):
            with self.subTest(text=text):
                result = classify_job(self.job(description=text), {})
                self.assertEqual(result["eligibility"]["status"], "unknown")
                self.assertEqual(result["decision"], "review")

    def test_cpt_acceptance_and_no_future_sponsorship(self):
        for text in (
            "We accept CPT/OPT students. We do not provide future sponsorship.",
            "We do not provide sponsorship, but CPT/OPT students are welcome.",
            "We do not provide sponsorship; international students are encouraged to apply.",
        ):
            with self.subTest(text=text):
                self.assertEqual(classify_job(self.job(description=text), {})["decision"], "eligible")

    def test_negated_acceptance_is_excluded(self):
        for text in (
            "We do not accept CPT or OPT.",
            "OPT candidates will not be considered.",
            "This role is not open to international students.",
            "We are not accepting candidates on CPT or OPT.",
            "Candidates using CPT/OPT will not be accepted.",
            "International students are not currently eligible.",
            "No CPT/OPT candidates.",
        ):
            with self.subTest(text=text):
                result = classify_job(self.job(description=text), {})
                self.assertEqual(result["eligibility"]["status"], "excluded")
                self.assertEqual(result["decision"], "excluded")

    def test_explicit_citizen_restriction(self):
        for text in (
            "Applicants must be U.S. citizens or permanent residents.",
            "U.S. citizenship is required.",
            "Only US citizens may apply.",
            "This position requires US citizenship.",
        ):
            with self.subTest(text=text):
                result = classify_job(self.job(description=text), {})
                self.assertEqual(result["eligibility"]["status"], "excluded")
                self.assertEqual(result["decision"], "excluded")

    def test_not_required_citizenship_is_unknown(self):
        result = classify_job(self.job(description="U.S. citizenship is not required."), {})
        self.assertEqual(result["eligibility"]["status"], "unknown")

    def test_export_controls_and_clearances_require_review(self):
        for text in (
            "We accept CPT/OPT students. Export control regulations apply.",
            "We accept CPT/OPT students. ITAR review may be necessary.",
            "We accept CPT/OPT students. Security clearance eligibility is assessed.",
        ):
            with self.subTest(text=text):
                result = classify_job(self.job(description=text), {})
                self.assertEqual(result["decision"], "review")
                self.assertTrue(any("clearance" in reason for reason in result["reasons"]))

    def test_explicit_restriction_takes_precedence(self):
        for text in (
            "We accept OPT students. We do not accept international students.",
            "We accept CPT students. Applicants must be U.S. citizens.",
            "We do not accept CPT, but OPT students are welcome.",
        ):
            with self.subTest(text=text):
                result = classify_job(self.job(description=text), {})
                self.assertEqual(result["eligibility"]["status"], "unknown")
                self.assertEqual(result["decision"], "excluded")

    def test_conditional_and_question_text_is_not_acceptance(self):
        for text in (
            "Do you accept CPT/OPT students?",
            "International students may be eligible depending on the team.",
            "CPT students are accepted on a case-by-case basis.",
        ):
            with self.subTest(text=text):
                self.assertEqual(classify_job(self.job(description=text), {})["eligibility"]["status"], "unknown")

    def test_structured_authorization_has_labeled_source_evidence(self):
        result = classify_job(self.job(description="Build RTL.", structured_authorization={"accepts_cpt": True, "sponsorship": False}), {})
        self.assertEqual(result["decision"], "eligible")
        self.assertIn("structured_authorization.accepts_cpt=true", result["eligibility"]["evidence"])

    def test_structured_false_is_not_ignored(self):
        result = classify_job(self.job(structured_authorization={"accepts_cpt": False}), {})
        self.assertEqual(result["decision"], "excluded")
        self.assertEqual(result["eligibility"]["status"], "unknown")

    def test_structured_citizenship_is_exclusion(self):
        result = classify_job(self.job(description="Design FPGA hardware.", structured_authorization={"requires_citizenship": True}), {})
        self.assertEqual(result["decision"], "excluded")
        self.assertIn("structured_authorization.requires_citizenship=true", result["eligibility"]["evidence"])

    def test_missing_or_partial_description_needs_review(self):
        for changes in ({"description": "", "structured_authorization": {"accepts_cpt": True}}, {"description_is_summary": True}):
            with self.subTest(changes=changes):
                result = classify_job(self.job(**changes), {})
                self.assertEqual(result["decision"], "review")
                self.assertTrue(any("description" in reason for reason in result["reasons"]))

    def test_source_terms_match_whole_pairs(self):
        result = classify_job(self.job(title="FPGA Internship", source_terms=["Fall 2027", "Summer 2027"]), {})
        self.assertEqual(result["decision"], "eligible")
        result = classify_job(self.job(title="FPGA Internship", source_terms=["Summer 2026", "Fall 2027"]), {})
        self.assertEqual(result["decision"], "excluded")

    def test_export_license_alternative_is_not_citizen_only(self):
        result = classify_job(self.job(description="Applicants must be U.S. citizens or eligible to obtain an export license."), {})
        self.assertEqual(result["decision"], "review")
        self.assertEqual(result["eligibility"]["status"], "unknown")

    def test_wrong_season_year_and_country_excluded(self):
        for changes in (
            {"title": "FPGA Internship - Summer 2026"},
            {"title": "FPGA Internship - Fall 2027"},
            {"location": "London, United Kingdom"},
            {"location": "Toronto, Canada"},
        ):
            with self.subTest(changes=changes):
                self.assertEqual(classify_job(self.job(**changes), {})["decision"], "excluded")

    def test_missing_year_season_or_location_is_review(self):
        for changes in (
            {"title": "FPGA Internship - Summer"},
            {"title": "FPGA Internship - 2027"},
            {"location": "Remote"},
            {"location": ""},
        ):
            with self.subTest(changes=changes):
                self.assertEqual(classify_job(self.job(**changes), {})["decision"], "review")

    def test_us_remote_and_multi_location_support_us(self):
        for location in ("Remote (United States)", "US", "Boston, Massachusetts", "United States or Canada"):
            with self.subTest(location=location):
                self.assertEqual(classify_job(self.job(location=location), {})["decision"], "eligible")

    def test_posting_and_graduation_dates_do_not_date_internship(self):
        result = classify_job(self.job(title="FPGA Summer Internship", description="Posted in 2026. Candidates must graduate in Summer 2027. We accept CPT students."), {})
        self.assertEqual(result["decision"], "review")
        self.assertIn("Internship year is missing or ambiguous", result["reasons"])

    def test_description_term_can_supply_dates(self):
        result = classify_job(self.job(title="FPGA Internship", description="Join our Summer 2027 internship program. We accept CPT students."), {})
        self.assertEqual(result["decision"], "eligible")

    def test_structured_start_date_can_supply_term(self):
        result = classify_job(self.job(title="FPGA Internship", start_date="2027-06-01"), {})
        self.assertEqual(result["decision"], "eligible")

    def test_ambiguous_dates_review(self):
        result = classify_job(self.job(title="FPGA Summer/Fall Internship 2027"), {})
        self.assertEqual(result["decision"], "review")

    def test_resume_specializations(self):
        for title, description, template in (
            ("Embedded Hardware Intern - Summer 2027", "Build firmware and integrate sensors with STM32.", "robotics"),
            ("Power Electronics Intern - Summer 2027", "Design power converters, inverters, and battery management systems.", "power"),
            ("RTL Intern - Summer 2027", "Verify Verilog designs using UVM.", "fpga"),
        ):
            with self.subTest(template=template):
                result = classify_job(self.job(title=title, description=description + " We accept CPT students."), {})
                self.assertEqual(result["template"], template)
                self.assertEqual(result["decision"], "eligible")

    def test_generic_hardware_template_needs_review(self):
        result = classify_job(self.job(title="Hardware Intern - Summer 2027", description="Assist our electrical engineering team. We accept CPT students."), {})
        self.assertIs(result["is_hardware"], True)
        self.assertEqual(result["decision"], "review")

    def test_non_hardware_and_senior_roles_do_not_qualify(self):
        for title in ("Hardware Marketing Intern - Summer 2027", "Software Engineering Intern - Summer 2027", "Senior FPGA Engineer - Summer 2027"):
            with self.subTest(title=title):
                result = classify_job(self.job(title=title, description="We accept CPT students."), {})
                self.assertEqual(result["decision"], "excluded")

    def test_software_role_touching_hardware_needs_review(self):
        result = classify_job(self.job(title="Robotics Software Intern - Summer 2027", description="Build software for hardware teams. We accept CPT students."), {})
        self.assertIsNone(result["is_hardware"])
        self.assertEqual(result["decision"], "review")


if __name__ == "__main__":
    unittest.main()


class AuthorizationCategoryTests(unittest.TestCase):
    def test_categories(self):
        for description, category in [
            ("We accept CPT students.", "cpt_accepted"),
            ("Students on curricular practical training are welcome.", "cpt_accepted"),
            ("International students are welcome.", "international_accepted"),
            ("Build FPGA hardware.", "risky"),
            ("We do not accept international students.", "discarded"),
            ("We accept CPT students. We do not accept international students.", "discarded"),
            ("CPT students may be eligible depending on the team.", "review"),
            ("", "review"),
        ]:
            with self.subTest(description=description):
                result = classify_job({"description": description})
                self.assertEqual(result["eligibility"]["category"], category)
