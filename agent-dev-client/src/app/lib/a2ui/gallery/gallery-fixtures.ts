/**
 * Gallery fixture data — neutral sample props for every builtin surface so
 * `?gallery=1` can render the whole catalog without an agent. Display-only
 * dev data; never shipped into agent behavior.
 */

/** Self-contained placeholder image (no network). */
const PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23cbd5e1'/%3E%3Cstop offset='1' stop-color='%2394a3b8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='640' height='360' fill='url(%23g)'/%3E%3C/svg%3E";

export interface GalleryEntry {
  /** Registry key — must match `BUILTIN_SURFACE_COMPONENTS`. */
  component: string;
  /** Section label; distinguishes variants of one component. */
  label: string;
  props: Record<string, unknown>;
}

export const GALLERY_ENTRIES: GalleryEntry[] = [
  {
    component: 'List',
    label: 'List — sections + selectable',
    props: {
      title: 'What we offer',
      selectable: true,
      items: [
        {
          id: 'basic',
          title: 'Basic check',
          description: 'A quick once-over',
          value: '$25',
          section: 'Standard',
        },
        {
          id: 'full',
          title: 'Full inspection',
          description: 'The complete work-up',
          value: '$60',
          section: 'Standard',
        },
        {
          id: 'express',
          title: 'Express handling',
          description: 'Same-day turnaround',
          value: '+$15',
          section: 'Extras',
        },
        { id: 'pickup', title: 'Pick-up & return', value: '+$10', section: 'Extras' },
      ],
    },
  },
  {
    component: 'Steps',
    label: 'Steps — process status',
    props: {
      title: 'Where your request is',
      steps: [
        { label: 'Received', caption: 'Mon 09:14', state: 'done' },
        { label: 'In progress', caption: 'Started this morning', state: 'active' },
        { label: 'Quality check', state: 'pending' },
        { label: 'Ready for pickup', state: 'pending' },
      ],
    },
  },
  {
    component: 'OptionGrid',
    label: 'OptionGrid — cards with price, image, featured',
    props: {
      title: 'Pick a plan',
      subtitle: 'You can change any time.',
      options: [
        {
          id: 'starter',
          name: 'Starter',
          description: 'The essentials to get going.',
          price: '$19',
          priceCaption: 'per month',
          meta: 'up to 3 seats',
          imageUrl: PLACEHOLDER_IMAGE,
        },
        {
          id: 'growth',
          name: 'Growth',
          description: 'Everything in Starter, plus automation.',
          price: '$49',
          priceCaption: 'per month',
          meta: 'up to 10 seats',
          featured: true,
          imageUrl: PLACEHOLDER_IMAGE,
        },
        {
          id: 'scale',
          name: 'Scale',
          description: 'For teams that need it all.',
          price: '$99',
          priceCaption: 'per month',
          meta: 'unlimited seats',
          imageUrl: PLACEHOLDER_IMAGE,
        },
      ],
    },
  },
  {
    component: 'ChoiceBoard',
    label: 'ChoiceBoard — grouped slots + selection',
    props: {
      title: 'Pick a time',
      subtitle: 'All times local.',
      selectedId: 'thu-1100',
      columns: [
        {
          heading: 'Thursday',
          caption: '3 open',
          items: [
            { id: 'thu-0900', label: '9:00' },
            { id: 'thu-1100', label: '11:00' },
            { id: 'thu-1500', label: '15:00', caption: 'last one' },
          ],
        },
        {
          heading: 'Friday',
          caption: '2 open',
          items: [
            { id: 'fri-1000', label: '10:00' },
            { id: 'fri-1400', label: '14:00' },
            { id: 'fri-1600', label: '16:00', disabled: true },
          ],
        },
        {
          heading: 'Saturday',
          caption: 'morning only',
          items: [
            { id: 'sat-0930', label: '9:30' },
            { id: 'sat-1130', label: '11:30' },
          ],
        },
      ],
    },
  },
  {
    component: 'Form',
    label: 'Form — fields, prefill, error',
    props: {
      title: 'Your details',
      subtitle: 'We only use this to get back to you.',
      submitLabel: 'Send request',
      fields: [
        { id: 'name', label: 'Name', kind: 'text', value: 'Ana Petrova', prefilled: true },
        {
          id: 'email',
          label: 'Email',
          kind: 'email',
          errors: ['That does not look like an email'],
        },
        { id: 'phone', label: 'Phone', kind: 'phone' },
        {
          id: 'topic',
          label: 'Topic',
          kind: 'choice',
          options: ['General question', 'Quote', 'Follow-up'],
        },
        { id: 'notes', label: 'Anything else?', kind: 'note' },
      ],
    },
  },
  {
    component: 'Summary',
    label: 'Summary — draft (editable, commit CTA)',
    props: {
      title: 'Please review',
      commitLabel: 'Confirm',
      status: 'draft',
      footnote: 'Nothing is final until you confirm.',
      lines: [
        { key: 'what', label: 'What', value: 'Full inspection', caption: 'about 60 min' },
        { key: 'when', label: 'When', value: 'Thu 11:00', editable: true },
        { key: 'contact', label: 'Contact', value: 'ana@example.com', editable: true },
      ],
    },
  },
  {
    component: 'Summary',
    label: 'Summary — confirmed (success hero)',
    props: {
      commitLabel: 'Confirm',
      status: 'confirmed',
      confirmedTitle: 'All set!',
      confirmedSubtitle: 'We sent a confirmation to your email.',
      lines: [
        { key: 'what', label: 'What', value: 'Full inspection' },
        { key: 'when', label: 'When', value: 'Thu 11:00' },
        { key: 'ref', label: 'Reference', value: 'RQ-1042' },
      ],
    },
  },
  {
    component: 'Table',
    label: 'Table',
    props: {
      title: 'Opening hours',
      columns: [
        { header: 'Day', accessor: 'd' },
        { header: 'Open', accessor: 'o' },
        { header: 'Close', accessor: 'c' },
      ],
      rows: [
        ['Mon–Fri', '9:00', '18:00'],
        ['Saturday', '10:00', '16:00'],
        ['Sunday', 'closed', '—'],
      ],
    },
  },
  {
    component: 'Chart',
    label: 'Chart — bar, two series',
    props: {
      chartType: 'bar',
      title: 'Visits per weekday',
      description: 'Last two weeks compared.',
      categories: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      series: [
        { label: 'This week', values: [12, 19, 9, 22, 16] },
        { label: 'Last week', values: [10, 14, 11, 18, 13] },
      ],
    },
  },
  {
    component: 'Chart',
    label: 'Chart — donut',
    props: {
      chartType: 'pie',
      title: 'Requests by channel',
      categories: ['Website', 'Phone', 'Walk-in'],
      series: [{ label: 'Requests', values: [48, 21, 13] }],
    },
  },
  {
    component: 'Chart',
    label: 'Chart — area, stacked',
    props: {
      chartType: 'area',
      title: 'Weekly volume',
      stacked: true,
      categories: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'],
      series: [
        { label: 'New', values: [14, 18, 16, 22, 24, 28] },
        { label: 'Returning', values: [8, 9, 12, 12, 15, 17] },
      ],
    },
  },
  {
    component: 'Image',
    label: 'Image',
    props: {
      src: PLACEHOLDER_IMAGE,
      alt: 'Placeholder image',
    },
  },
  {
    component: 'Video',
    label: 'Video',
    props: {
      src: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
      title: 'Sample clip',
      poster: PLACEHOLDER_IMAGE,
    },
  },
  {
    component: 'FileDownload',
    label: 'FileDownload',
    props: {
      filename: 'summary.pdf',
      path: '/files/summary.pdf',
    },
  },
  {
    component: 'TextBlock',
    label: 'TextBlock — prose + blocks',
    props: {
      title: 'About the workshop',
      subtitle: 'What we do and how we work',
      body: 'We repair small electronics with **same-week turnaround** on most jobs.',
      blocks: [
        { type: 'heading', text: 'Opening hours' },
        { type: 'text', text: 'Mon-Fri 9:00-17:00, Sat by appointment.' },
        {
          type: 'image',
          imageUrl: PLACEHOLDER_IMAGE,
          imageAlt: 'Workbench',
          caption: 'The bench',
        },
        { type: 'button', label: 'Get an estimate', intent: 'I want an estimate' },
        {
          type: 'button',
          label: 'Ask a question',
          intent: 'I have a question',
          kind: 'secondary',
        },
      ],
    },
  },
];
