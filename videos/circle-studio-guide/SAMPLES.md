# Try Circle Studio

Use a new practice folder for each example. Open **Let's begin** from the AI tools link and sign in to at least one supported tool. From Home, choose **Open a folder** or **New project**. In Workflow, give each agent a job and choose an engine you have installed. Review generated files before writing them.

## 1. Bakery website — the video example

Suggested workflow: Plan → Build → Review. Put a human checkpoint after Plan and Review. A Planner writes the outline; a Builder implements it; a Reviewer checks the result. These are roles you configure, not a claim that all stages run automatically.

Paste into Chat:

> Build a one-page website for a fictional neighborhood bakery called Morning Crumb. Include a welcoming headline, a sample menu, opening hours, and a contact section. Use placeholder contact information clearly marked as fictional. Make it work on mobile and with a keyboard. First inspect this folder and propose a plan. Show proposed changes before applying them. After implementation, explain how to preview it and report the checks you ran.

Acceptance: menu, hours, and contact sections are present; layout works at narrow width; links and buttons are reachable by keyboard; record the actual checks in Tasks & progress.

## 2. Small bug fix

Suggested workflow: Reproduce → Fix → Review. Choose your existing practice repository; describe a real bug instead of inventing a failing result.

> Investigate this bug: [describe the actual behavior and expected behavior]. Read the relevant code and reproduce the problem if possible. Propose the smallest change, ask before writing, and run the relevant checks. Report what passed, what failed, and anything you could not verify. Do not commit or push.

Acceptance: record reproduction steps, changed files, and the actual check output. Accept the task only after you review those results.

## 3. Research brief

Suggested workflow: Gather → Compare → Review. Use an engine with the tools and browsing access required for your topic.

> Research [topic] for [audience]. Compare three practical options against [constraints]. Link the primary sources, give their dates, distinguish facts from assumptions, and end with one recommendation and its trade-offs. Propose a Markdown outline first. Save the brief only after I review the proposed file changes.

Acceptance: source links open; dated claims are checked; assumptions are labeled; the recommendation addresses the constraints.

## Everyday controls

- **Chat:** choose an engine, write a concrete request, then Send. Earlier conversations reopens saved work.
- **Workflow → Review and write files:** inspect the diff before Write files.
- **Inbox:** revisit approvals and questions raised by the engine. Approval coverage depends on the engine and its policy.
- **Tasks & progress:** add evidence and a human review before marking a task accepted.
- **Library / agent settings:** find a relevant skill and attach it to the role that needs it.
- **Widgets:** choose the activity and attention tiles you want to keep visible.

The video shows a temporary sample project, simulated engine readiness, illustrative messages, and sample task evidence. It does not show a real AI building or shipping the bakery website.
