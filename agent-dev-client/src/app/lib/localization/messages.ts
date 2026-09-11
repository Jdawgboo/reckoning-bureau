import { defineMessages } from 'react-intl';

/** Stable visitor-facing wording owned by the agent shell and built-in components. */
export const messages = defineMessages({
  loading: { id: 'common.loading', defaultMessage: 'Loading…' },
  agentName: { id: 'common.agentName', defaultMessage: 'Agent' },
  close: { id: 'common.close', defaultMessage: 'Close' },
  more: { id: 'common.more', defaultMessage: 'More' },
  select: { id: 'common.select', defaultMessage: 'Select' },
  submit: { id: 'common.submit', defaultMessage: 'Submit' },
  confirm: { id: 'common.confirm', defaultMessage: 'Confirm' },
  edit: { id: 'common.edit', defaultMessage: 'Edit' },
  confirming: { id: 'common.confirming', defaultMessage: 'Confirming…' },
  confirmed: { id: 'common.confirmed', defaultMessage: 'Confirmed' },
  working: { id: 'common.working', defaultMessage: 'Working…' },
  thinking: { id: 'common.thinking', defaultMessage: 'Thinking…' },

  narrationScreenReady: {
    id: 'narration.screenReady',
    defaultMessage: 'Getting your screen ready…',
    description: 'Short live status shown while the agent renders a visual interface.',
  },
  narrationSavingDetails: {
    id: 'narration.savingDetails',
    defaultMessage: 'Saving your details…',
    description: 'Short live status shown while the agent records information.',
  },
  narrationPassingAlong: {
    id: 'narration.passingAlong',
    defaultMessage: 'Passing this along…',
    description: 'Short live status shown while the agent sends a message or notification.',
  },
  narrationLookingUp: {
    id: 'narration.lookingUp',
    defaultMessage: 'Looking that up…',
    description: 'Short live status shown while the agent searches for information.',
  },
  narrationCheckingNotes: {
    id: 'narration.checkingNotes',
    defaultMessage: 'Checking our notes…',
    description: 'Short live status shown while the agent reads files or stored information.',
  },
  narrationResearchingInitial: {
    id: 'narration.researchingInitial',
    defaultMessage: 'Researching… This usually takes a minute or two.',
    description: 'Live status shown before the first deep-research search begins.',
  },
  narrationResearching: {
    id: 'narration.researching',
    defaultMessage: 'Researching: {currentSearch} ({searchCount}) · Sources: {sourceCount}',
    description:
      'Live deep-research status. currentSearch is the query, searchCount is progress, and sourceCount is the number of sources found.',
  },

  askAnything: { id: 'composer.askAnything', defaultMessage: 'Ask me anything' },
  attachFiles: { id: 'composer.attachFiles', defaultMessage: 'Attach files' },
  removeAttachment: {
    id: 'composer.removeAttachment',
    defaultMessage: 'Remove {filename}',
    description: 'Accessible label for removing one attached file.',
  },
  attachmentTooLarge: {
    id: 'composer.attachmentTooLarge',
    defaultMessage: '{filename} exceeds 5 MB and was skipped',
  },
  attachmentUnsupported: {
    id: 'composer.attachmentUnsupported',
    defaultMessage: '{filename} ({extension}) is not a supported format',
  },
  attachmentLimit: {
    id: 'composer.attachmentLimit',
    defaultMessage:
      'You can attach up to {count, plural, one {# file} other {# files}} per message',
  },
  voiceMode: { id: 'composer.voiceMode', defaultMessage: 'Voice mode' },
  stopGenerating: { id: 'composer.stopGenerating', defaultMessage: 'Stop generating' },
  send: { id: 'composer.send', defaultMessage: 'Send' },

  muteMicrophone: { id: 'voice.muteMicrophone', defaultMessage: 'Mute microphone' },
  unmuteMicrophone: { id: 'voice.unmuteMicrophone', defaultMessage: 'Unmute microphone' },
  tapToSpeak: { id: 'voice.tapToSpeak', defaultMessage: 'Tap to speak' },
  tapToSend: { id: 'voice.tapToSend', defaultMessage: 'Tap to send' },
  endVoice: { id: 'voice.end', defaultMessage: 'End voice' },
  voiceConnecting: { id: 'voice.connecting', defaultMessage: 'Connecting' },
  voiceThinking: { id: 'voice.thinking', defaultMessage: 'Thinking' },
  voiceStartFailed: {
    id: 'voice.startFailed',
    defaultMessage: 'Could not start voice. Check microphone access.',
  },
  voiceConnectionProblem: {
    id: 'voice.connectionProblem',
    defaultMessage: 'Voice connection problem: {reason}',
  },
  voiceUnknownError: { id: 'voice.unknownError', defaultMessage: 'Voice service error.' },

  siteNavigation: { id: 'navigation.site', defaultMessage: 'Site navigation' },
  openMenu: { id: 'navigation.openMenu', defaultMessage: 'Open menu' },
  closeMenu: { id: 'navigation.closeMenu', defaultMessage: 'Close menu' },
  requestHistory: { id: 'navigation.requestHistory', defaultMessage: 'Request history' },
  home: { id: 'navigation.home', defaultMessage: 'Home' },
  turn: {
    id: 'navigation.turn',
    defaultMessage: 'Turn {number}: {label}',
  },
  browseTurns: {
    id: 'navigation.browseTurns',
    defaultMessage: 'Drag or click to browse turns',
  },

  couldNotConnect: {
    id: 'stage.couldNotConnect',
    defaultMessage: 'Couldn’t connect. Tap to retry.',
  },
  connecting: { id: 'stage.connecting', defaultMessage: 'Connecting…' },
  gettingReady: { id: 'stage.gettingReady', defaultMessage: 'Getting ready…' },
  pageLoadFailed: {
    id: 'stage.pageLoadFailed',
    defaultMessage: 'Something went wrong loading this page. Tap to retry.',
  },
  transcriptOpen: {
    id: 'stage.transcriptOpen',
    defaultMessage: 'The conversation transcript is open.',
  },
  workInProgress: { id: 'stage.workInProgress', defaultMessage: 'Work is in progress.' },
  dismiss: { id: 'stage.dismiss', defaultMessage: 'Dismiss' },
  retry: { id: 'stage.retry', defaultMessage: 'Retry' },
  localizationPreparing: {
    id: 'localization.preparing',
    defaultMessage: 'Teaching this agent to speak your language…',
    description:
      'Warm personalized status shown while the target language activates. Preserve the meaning that the agent is learning to speak the visitor’s language.',
  },
  localizationLanguageSelfName: {
    id: 'localization.languageSelfName',
    defaultMessage: 'English',
    description:
      'The generated target locale’s own name for itself. For French use Français; for Georgian use ქართული. Do not translate the word English literally.',
  },
  localizationFailed: {
    id: 'localization.failed',
    defaultMessage: 'Couldn’t prepare {language}. Continuing in {activeLanguage}.',
  },
  screenTextTruncated: {
    id: 'stage.screenTextTruncated',
    defaultMessage: '… [screen text truncated]',
  },

  searchingFiles: { id: 'process.searchingFiles', defaultMessage: 'Searching files…' },
  noMatches: { id: 'process.noMatches', defaultMessage: 'No matches found' },
  matchesFound: {
    id: 'process.matchesFound',
    defaultMessage: '{count, plural, one {Found # match} other {Found # matches}}',
  },
  sourcesLabel: { id: 'sources.label', defaultMessage: 'Sources' },
  researchFailed: { id: 'process.researchFailed', defaultMessage: 'Research failed' },
  subagent: { id: 'process.subagent', defaultMessage: 'Sub-agent' },
  toolCalls: {
    id: 'process.toolCalls',
    defaultMessage: '{count, plural, one {# tool call} other {# tool calls}}',
  },
  subagentFailed: {
    id: 'process.subagentFailed',
    defaultMessage: '{label} failed',
  },
  subagentFailedWithReason: {
    id: 'process.subagentFailedWithReason',
    defaultMessage: '{label} failed: {reason}',
  },

  choices: { id: 'surface.choices', defaultMessage: 'Choices' },
  options: { id: 'surface.options', defaultMessage: 'Options' },
  menu: { id: 'surface.menu', defaultMessage: 'Menu' },
  featured: { id: 'surface.featured', defaultMessage: 'Featured' },
  imageLoading: { id: 'surface.imageLoading', defaultMessage: 'Loading image…' },
  viewCouldNotDisplay: {
    id: 'surface.viewCouldNotDisplay',
    defaultMessage: 'This view could not be displayed.',
  },
  link: { id: 'surface.link', defaultMessage: 'Link' },
  filePathMissing: {
    id: 'surface.filePathMissing',
    defaultMessage: 'File download is missing a storage path.',
  },
  downloadFailed: {
    id: 'surface.downloadFailed',
    defaultMessage: 'Download failed: {reason}',
  },
  imageError: { id: 'surface.imageError', defaultMessage: 'Image error: {reason}' },
  videoPlaceholder: { id: 'surface.videoPlaceholder', defaultMessage: 'Video placeholder' },
  videoUnavailable: {
    id: 'surface.videoUnavailable',
    defaultMessage: 'Unfortunately, we could not load the video from',
  },
  possibleReasons: { id: 'surface.possibleReasons', defaultMessage: 'Possible reasons:' },
  videoUrlProblem: { id: 'surface.videoUrlProblem', defaultMessage: 'Empty or incorrect URL' },
  videoFormatProblem: { id: 'surface.videoFormatProblem', defaultMessage: 'Unsupported format' },
  videoPrivacyProblem: {
    id: 'surface.videoPrivacyProblem',
    defaultMessage: 'The video is unavailable because of its privacy or streaming settings.',
  },
  seriesLabel: { id: 'surface.seriesLabel', defaultMessage: 'Series {number}' },
  categoryLabel: { id: 'surface.categoryLabel', defaultMessage: 'Category' },
  videoLabel: { id: 'surface.videoLabel', defaultMessage: 'Video' },
  titledVideoLabel: { id: 'surface.titledVideoLabel', defaultMessage: 'Video: {title}' },
  disabledSuffix: { id: 'surface.disabledSuffix', defaultMessage: '{label} (disabled)' },

  selectPlaceholder: { id: 'form.selectPlaceholder', defaultMessage: 'Select…' },
  prefilled: { id: 'form.prefilled', defaultMessage: 'pre-filled' },
  pickDate: { id: 'form.pickDate', defaultMessage: 'Pick a date' },
  year: { id: 'form.year', defaultMessage: 'Year' },
  month: { id: 'form.month', defaultMessage: 'Month' },
  previousMonth: { id: 'calendar.previousMonth', defaultMessage: 'Previous month: {month}' },
  nextMonth: { id: 'calendar.nextMonth', defaultMessage: 'Next month: {month}' },
  chooseMonth: { id: 'calendar.chooseMonth', defaultMessage: 'Choose month' },
  chooseYear: { id: 'calendar.chooseYear', defaultMessage: 'Choose year' },
  weekNumber: { id: 'calendar.weekNumber', defaultMessage: 'Week {number}' },

  carouselPrevious: { id: 'carousel.previous', defaultMessage: 'Previous slide' },
  carouselNext: { id: 'carousel.next', defaultMessage: 'Next slide' },
  breadcrumb: { id: 'breadcrumb.label', defaultMessage: 'Breadcrumb' },
  breadcrumbMore: { id: 'breadcrumb.more', defaultMessage: 'More' },
  pagination: { id: 'pagination.label', defaultMessage: 'Pagination' },
  previousPage: { id: 'pagination.previous', defaultMessage: 'Previous page' },
  goToPreviousPage: {
    id: 'pagination.goToPrevious',
    defaultMessage: 'Go to previous page',
  },
  nextPage: { id: 'pagination.next', defaultMessage: 'Next page' },
  goToNextPage: { id: 'pagination.goToNext', defaultMessage: 'Go to next page' },
  morePages: { id: 'pagination.more', defaultMessage: 'More pages' },
  toggleSidebar: { id: 'sidebar.toggle', defaultMessage: 'Toggle sidebar' },

  agentNotFoundTitle: { id: 'error.agentNotFoundTitle', defaultMessage: 'Agent not found' },
  agentNotFoundBody: {
    id: 'error.agentNotFoundBody',
    defaultMessage:
      'The agent you are looking for could not be found or has not been published yet. Check the details and try again.',
  },
  genericTitle: { id: 'error.genericTitle', defaultMessage: 'Something went wrong' },
  genericBody: {
    id: 'error.genericBody',
    defaultMessage: 'Please refresh the page and try again.',
  },
  authentication: { id: 'error.authentication', defaultMessage: 'Authentication error' },
  wrongAccount: {
    id: 'error.wrongAccount',
    defaultMessage:
      'This conversation belongs to a different account. Start a new one to continue.',
  },
  unexpected: { id: 'error.unexpected', defaultMessage: 'An unexpected error occurred.' },
  requestFailed: {
    id: 'error.requestFailed',
    defaultMessage: 'Sorry, an error occurred while processing your request. Please try again.',
  },
  retryExhausted: {
    id: 'error.retryExhausted',
    defaultMessage:
      'The model provider is temporarily unavailable. Please try again in a few minutes or select a different model.',
  },
  creditsExhausted: {
    id: 'error.creditsExhausted',
    defaultMessage:
      'This agent has run out of credits. Please contact the agent owner to restore service.',
  },
  providerUnavailable: {
    id: 'error.providerUnavailable',
    defaultMessage:
      'The selected model is temporarily unavailable. Please try again in a few minutes or select a different model.',
  },
  modelOverloaded: {
    id: 'error.modelOverloaded',
    defaultMessage:
      'The selected model is overloaded. Please try again in a few minutes or select a different model.',
  },
  budgetExhausted: {
    id: 'error.budgetExhausted',
    defaultMessage: 'I need more tokens to perform this task.',
  },
});
