'use strict';

// Jira ticket tags on Twism task cards, and the link to the user's in-progress board.
const { PRIMARY_PROFILE } = require('./profiles.cjs');

const JIRA_BROWSE = 'https://twism.atlassian.net/browse/';
const JIRA_BOARD_URL = 'https://twism.atlassian.net/jira/software/c/projects/TWISM/boards/228';
const TICKET = /^TWISM-\d{1,6}$/;
const MAX_TICKETS = 5;
const ID_PREFIX = /^(\d{4,6})-/;
// An id that starts with a date (2026-11-recap) is not a ticket number.
const DATE_PREFIX = /^(19|20)\d{2}-\d{2}(-|$)/;
const BRANCH_TICKET = /TWISM-(\d{1,6})/i;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ticketHref = (key) => (TICKET.test(String(key)) ? `${JIRA_BROWSE}${key}` : '');

const derived = (meta) => {
  const id = String(meta.id || '');
  const prefix = !DATE_PREFIX.test(id) && id.match(ID_PREFIX);
  if (prefix) return [`TWISM-${prefix[1]}`];
  const branch = String(meta.branch || '').match(BRANCH_TICKET);
  return branch ? [`TWISM-${branch[1]}`] : [];
};

// meta.tickets comes from `spawn --ticket`; an empty list is `--ticket none` and turns the guess off.
const ticketsOf = (meta, profile) => {
  if (profile !== PRIMARY_PROFILE) return [];
  const raw = Array.isArray(meta.tickets) ? meta.tickets : derived(meta);
  return [...new Set(raw.filter((key) => TICKET.test(String(key))))].slice(0, MAX_TICKETS);
};

const ticketTagsHtml = (tickets) => {
  if (!tickets.length) return '';
  const [first, ...rest] = tickets;
  const more = rest.length ? `<span class="tag" title="${esc(rest.join(', '))}">+${rest.length}</span>` : '';
  return `<a class="tag jira" href="${esc(ticketHref(first))}" target="_blank" rel="noopener noreferrer" title="Open ${esc(first)} in Jira">${esc(first)}</a>${more}`;
};

const jiraCss = `a.tag.jira{color:var(--blue-glow);border-color:color-mix(in srgb,var(--blue-glow) 45%,transparent);text-decoration:none}a.tag.jira:hover{text-decoration:underline}`;

module.exports = { JIRA_BROWSE, JIRA_BOARD_URL, TICKET, ticketsOf, ticketTagsHtml, ticketHref, jiraCss };
