# How Gode Tekster works

This is a reference guide.

You'll find the headings in the Outline tab on the left. You can also search with *Ctrl+F*.

## Your texts are your files

Gode Tekster saves ordinary text files with the .md extension in the folders you keep on your computer.

There's no database and no account.

When you opened Gode Tekster for the first time, it made a folder called Gode Tekster under Documents. It's in the Library tab on the left, along with the folders you add yourself.

At the top of the tab you can go up a level and choose *Add folder…* to include a new folder.

You make a new text with the plus sign at the top of the library. Ctrl+O finds a text by name, and Ctrl+Shift+O opens a file anywhere on your computer. Right-click a text to copy its path or show it in File Explorer.

You can drag Word files into the window. The app then offers to make a new text from them.

## Formatting

The formatting is in the text as characters (but the characters hide when the cursor isn't on the line). That's what's called markdown.

Under Markdown in Settings you can hide the characters completely, always show them, or see only the plain markdown without formatting.

- Bold: Ctrl+B.
- Italics: Ctrl+I.
- Underline: Ctrl+U.
- Strikethrough: Ctrl+Shift+X.
- Headings: Ctrl+1, Ctrl+2 and Ctrl+3.
- Ctrl+4 gives you a lead paragraph.
- Ctrl+0 turns the line back into body text.
- Lists: Ctrl+Shift+8 for bullets, Ctrl+Shift+7 for numbers and Ctrl+Shift+9 for checkboxes. Tab turns an item into a sub-item.
- Quote: Ctrl+Shift+Q.
- Link: Ctrl+K.
- Images: drag them in, or use Ctrl+Alt+I. The image is copied to a folder called medier next to the text, so it comes along if you move them both.

Alt+Up and Alt+Down move a whole paragraph. If the cursor is in a heading, the whole section under it moves along.

## Dimming, trimming and clippings

Dimmed text is text you haven't quite made up your mind about. It's shown in gray, and it doesn't count in the word count, in exports or when you print.

Ctrl+Shift+D dims the selection, and the same shortcut removes the dimming again.

## Notes, changes and footnotes

You make a note to yourself with Ctrl+Alt+N. It's shown in yellow and is left out when you print too.

You make footnotes with Ctrl+Alt+F. The number goes in the text, and you write the note itself in the Footnotes tab.

If you get a text back with changes from someone else, they're shown as suggestions you can accept or reject one at a time.

## Overview and calm

- Ctrl+J shows the outline: all the headings, with the one you're in highlighted.
- Ctrl+D is focus. Everything except the paragraph you're writing in fades.
- Ctrl+T is typewriter scrolling. The line you're writing on stays in the middle of the screen, like on a typewriter.
- F11 is Quiet mode: full screen with only the text, and the mouse pointer hides while you write. Esc brings everything back. The Wi-Fi button in the bottom left corner turns Wi-Fi off until you leave.
- The style check (F7) and parts of speech in color (Shift+F7) are built on Danish word lists, so they only work when Gode Tekster runs in Danish. The style check also finds common Danish grammar mistakes with present-tense -r and doubled words.
- Ctrl+plus and Ctrl+minus make the text bigger and smaller.

In Settings (Ctrl+,) you choose the font, line width, quotation marks and dark background. Under Paragraphs you choose whether paragraphs are separated by space, like on the web, or by indenting the first line, like in a book. The choice also applies to printing, PDF and Word.

## Search

Ctrl+F searches the text, and Ctrl+H finds and replaces. If you type / first in the search box, you search all the texts in your libraries at once.

## Slash commands

Type / at the start of a line or after a space, and you get a list of templates and commands. Keep typing to find the right one, pick it with the arrow keys, and press Enter. /date puts in today's date, for example.

If you've selected something, / works the same way, and the command then applies to the selection. /tidy, for example, cleans up text you pasted from an email. Esc closes the list.

If a command is missing, describe it in your own words under Commands in Settings (Ctrl+,). The program sets it up, and you see a preview before you save. Commands are ordinary files in Documents\Gode Tekster\Commands.

## Versions

The app keeps saving earlier versions of your text as you go. You'll find them in the Versions tab on the right. Click one to see it, and Restore this version brings it back. The current text is saved as its own version first, so nothing gets lost. Right-click a version to give it a name.

## Print, PDF and Word

Ctrl+R shows the text the way it will look. From there you can print, save as PDF or save as Word. Ctrl+P prints right away. Ctrl+Shift+C copies the selection as formatted text, so you can paste it into an email or into Word.

If the text has notes or changes you haven't decided on, they go into Word as comments and tracked changes. Untick »Notes and changes in Word« to send a clean copy.

## Several texts at once

Each text has its own window. Ctrl+N opens a new one, and Ctrl+click on a text in the library opens it in a new window. If you try to open a text that's already open, its window comes to the front.

A new window without a text shows your recent texts as small sheets of paper. Click one to open it.

## Help from a language model

Gode Tekster can use your own language model. You choose it in Settings, under AI help:

- Claude needs the Claude app and a Claude Pro or Max subscription.
- ChatGPT needs OpenAI's Codex app and a ChatGPT subscription.
- Gemini needs a key from Google AI Studio. The key is stored in Windows Credential Manager. With a free key, Trim and Clean up work, but Fact-check and Research don't, because they need web search, and Google's free tier doesn't include it. Turn on billing for the key, and they work too.
- Mistral needs a key from Mistral AI Studio, and there is a free plan. The key is stored in the same place. Trim, Clean up and the commands work, but Fact-check and Research don't, because the connection has no web search.

The buttons are in the Input tab on the right:

- Trim: one click trims a little, a double-click trims a lot. The suggestions are dimmed, not deleted, so you decide. Ctrl+Z undoes all of it.
- Fact-check: finds the claims in the text and looks for sources for them.
- Clean up: fixes typos, punctuation and paragraphs in quickly written text, including interview notes, but leaves the words yours. The old text goes to Clippings, and Ctrl+Z undoes it. Unclear spots are marked [?1] and explained in a note at the bottom.
- The Research box: ask a question, and the language model looks for answers on the web.

If you've selected something, it only applies to the selection. The text is sent to the language model you chose, through your own account. Gode Medier doesn't see it, and nothing changes in your file until you choose it yourself.

## When you close

The X or Alt+F4 closes the window, but the app waits by the clock in the bottom right corner, so the next text opens right away. Ctrl+Q quits completely. In Settings you can also choose whether Gode Tekster starts with Windows.

## When something goes wrong

Your text is saved a second and a half after you pause.

If a file is changed in another program while it's open here, Gode Tekster merges the two versions or asks you first.

If a file can't be saved, you'll be told and can save a copy somewhere else.

Errors are written to a log file without any of your text. If you find a bug, click the speech bubble in the bottom left corner, or write to troels@godemedier.dk. I read everything, but I can't promise to fix it or answer right away.

<!-- gt:parkeret id=p1 dato=2026-10-05
Clippings is the place for what has to go but is too good to throw away.

Ctrl+Alt+X moves the selection to the Clippings tab on the right.
If you drag a clipping back into the text, it lands where you drop it.
-->
