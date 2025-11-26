# KYBTC Bitcoin Metadata Manager - Design Guidelines

## Design Approach
**System-Based Approach**: Drawing from Material Design and modern crypto dashboard patterns (Coinbase, Ledger Live) optimized for data-intensive applications with complex workflows. Focus on clarity, efficiency, and trust-building through systematic design.

## Typography System

**Font Stack**: Inter via Google Fonts CDN
- Display/Headers: 600-700 weight, tight tracking (-0.02em)
- Body Text: 400 weight, 1.5 line-height
- Data/Tables: 500 weight, tabular-nums for numerical alignment
- Buttons/Labels: 600 weight, uppercase with 0.05em tracking

**Scale**: 
- Hero/Page Headers: text-3xl to text-4xl
- Section Headers: text-xl to text-2xl  
- Body/Forms: text-base
- Table Data: text-sm
- Labels/Meta: text-xs

## Layout System

**Spacing Primitives**: Tailwind units 2, 4, 6, 8, 12, 16
- Component padding: p-4 to p-6
- Section gaps: gap-8 to gap-12
- Form spacing: space-y-4
- Table cells: px-4 py-3

**Grid Structure**:
- Dashboard: Sidebar (280px fixed) + Main content (flex-1) + Right panel (360px contextual)
- Mobile: Stack to single column, drawer navigation
- Max content width: max-w-7xl for wide tables, max-w-3xl for forms

## Core Component Library

### Navigation
**Top Bar**: Fixed header with KYBTC logo (left), global search (center), user actions/settings (right) - h-16, border-b, backdrop-blur
**Sidebar**: Persistent left nav with icon+label items, collapsed state on mobile showing icons only

### Dashboard Layout
**Main View**: 
- Filter bar: Faceted search chips (tags, categories, date ranges) with clear-all action
- Record table: Sortable columns, row actions on hover, batch selection checkboxes
- Pagination: Bottom-aligned, showing "X-Y of Z records"

**Contextual Panel**: Slides in from right when record selected
- Sticky header with record type badge and close button
- Scrollable content area with collapsible sections
- Fixed footer with primary/secondary actions

### Data Display
**Tables**: 
- Header: Sticky, sortable indicators, optional filters per column
- Rows: Hover state, alternating subtle stripe, expandable details
- Cells: Left-aligned text, right-aligned numbers, icon+text combos
- Empty state: Centered illustration placeholder with CTA

**Cards**: 
- Grid layout for record overview (grid-cols-1 md:grid-cols-2 lg:grid-cols-3)
- Header with icon badge for record type
- Preview of key metadata fields
- Action menu (3-dot) top-right

### Forms & Inputs
**Form Layout**: 
- Single column for focus (max-w-2xl)
- Field groups with subtle dividers (border-t, pt-6)
- Labels above inputs, helper text below, required indicators

**Input Types**:
- Text fields: Full-width, consistent height (h-10), border-radius rounded-lg
- Multi-select: Tag chips with remove buttons, "+ Add" trigger
- File upload: Dashed border dropzone, thumbnail grid preview, progress bars
- Toggle switches: For boolean settings, inline labels

**Validation**: Inline error messages (text-sm, text-red-600), success states with checkmark icons

### Modals & Wizards
**Modal**: 
- Centered overlay with backdrop blur
- Header with title and close X
- Scrollable body (max-h-[80vh])
- Sticky footer with action buttons aligned right

**Wizard (Xpub Derivation)**:
- Stepper indicator at top showing progress (1→2→3)
- Single step visible per screen
- Back/Next navigation in footer
- Summary review before final save

### Specialized Components
**QR Scanner**: 
- Full-screen camera view on mobile
- Desktop: Centered camera feed (max-w-md) with instructions overlay
- Crosshair target indicator, flash on successful scan
- Permission prompts with clear instructions

**File Attachments**:
- Thumbnail grid (grid-cols-3 md:grid-cols-4 gap-4)
- Each thumbnail: Preview image, filename truncated, size badge, delete icon overlay on hover
- Upload button with camera/file picker options

**Bitcoin Address Display**: 
- Monospace font (font-mono)
- Copy button with click feedback
- Truncated middle with tooltip showing full value
- Type badge (P2PKH, P2WPKH, etc.)

### Feedback & States
**Loading**: Skeleton screens matching content layout, no spinners
**Empty States**: Illustration + heading + CTA button, centered in container
**Toasts**: Bottom-right notifications (success/error/info), auto-dismiss 4s, dismiss button
**Confirmations**: Modal dialog for destructive actions with clear consequences

## Accessibility Standards
- Focus visible: 2px outline with offset on all interactive elements
- Skip to main content link
- ARIA labels on icon-only buttons
- Keyboard shortcuts displayed in tooltips (Cmd+K for search, etc.)
- High contrast mode support through semantic class names

## Icons
**Library**: Heroicons (outline for nav/headers, solid for buttons/badges) via CDN
**Usage**: 
- Navigation: 20px icons
- Buttons: 16px inline with text
- Status badges: 12px
- Table actions: 16px

## Animations
**Minimal Motion**:
- Panel slides: 200ms ease-out
- Hover states: Instant (no transition)
- Modal/dropdown: Fade + scale from 95% (150ms)
- Loading: Simple opacity pulse, no complex keyframes

## Responsive Breakpoints
- Mobile: < 768px - Single column, drawer nav, stacked panels
- Tablet: 768-1024px - Two column where applicable, persistent sidebar
- Desktop: > 1024px - Full three-column layout capability