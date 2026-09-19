import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Privacy' }

const SECTIONS: Array<{ title: string; body: string[] }> = [
  {
    title: 'What it reads',
    body: [
      'On your computer: the app in front, its window title, how often you type and click, how long you have been idle, and — with your permission — one small screen frame at most every ten seconds.',
      'On your desk: a camera frame when something changes, and whether you are speaking.',
      'On your phone: whether you are still or walking and whether the screen is on — and on Android, with usage access, the app in front, time in each app and unlocks. iPhone does not allow that last part, and the app says so.',
    ],
  },
  {
    title: 'What it never reads',
    body: [
      'Which keys you press, or anything you type. Page contents. Your messages, notifications or anything on your phone’s screen. Password managers, banking apps and the lock screen are never captured, and you can add any app to that list.',
    ],
  },
  {
    title: 'What it keeps',
    body: [
      'Counts, titles and its own decisions: for each minute, what it thought you were doing, what it did about it, and whether that worked. That record is how it learns to interrupt less.',
      'Lumi One keeps nothing. It sends, and forgets.',
    ],
  },
  {
    title: 'The shutter',
    body: [
      'Lumi One has a mechanical shutter. Slide it shut and frames stop within 200 ms; none leave the unit while it stays shut. The desktop app shows it as closed, and the ring shows two amber dots.',
    ],
  },
  {
    title: 'What it does to your computer',
    body: [
      'Only what your goal allows — muting a site, pausing notifications, starting a break. Every change is shown and can be undone in one click, and each one is recorded with whether you undid it.',
    ],
  },
  {
    title: 'Where the model runs',
    body: [
      'Assessment runs on the Lumi server, the only place that holds a model key. Neither the apps nor Lumi One ever calls a model.',
    ],
  },
]

export default function PrivacyPage() {
  return (
    <article className="mx-auto flex max-w-[760px] flex-col gap-14 px-5 py-16 md:py-24">
      <header className="flex flex-col gap-4">
        <h1 className="text-display-2 font-semibold tracking-tight text-text md:text-display-1">Privacy, plainly.</h1>
        <p className="text-title-3 font-normal text-text-muted">
          It watches one person who asked it to, keeps counts and titles, and never keystrokes or page contents.
        </p>
      </header>
      {SECTIONS.map((s) => (
        <section key={s.title} className="flex flex-col gap-3 border-t border-border pt-6">
          <h2 className="text-title-3 font-semibold text-text">{s.title}</h2>
          {s.body.map((p) => (
            <p key={p} className="text-body text-text-muted">
              {p}
            </p>
          ))}
        </section>
      ))}
    </article>
  )
}
