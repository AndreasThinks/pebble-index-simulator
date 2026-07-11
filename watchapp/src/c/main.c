/*
 * Index Notes — dictate a voice note on your Pebble and have it appear in
 * the Pebble mobile app's Index feed.
 *
 * Flow:
 *   SELECT → Dictation API session → phone transcribes → text comes back
 *   → sent to the PebbleKit JS companion via AppMessage → companion writes
 *   a RecordingDocument to the user's Firestore recordings collection,
 *   which the Pebble app ingests into the Index feed.
 *
 * If the companion is unreachable when a note is taken, the note is
 * persisted on the watch and resent automatically on the next launch.
 */

#include <pebble.h>

#define NOTE_BUFFER_SIZE 512

// Persist keys for the store-and-forward fallback.
#define PERSIST_KEY_PENDING_TEXT 1
#define PERSIST_KEY_PENDING_EPOCH 2

static Window *s_window;
static TextLayer *s_title_layer;
static TextLayer *s_status_layer;
static TextLayer *s_hint_layer;

static DictationSession *s_dictation;

static char s_note_text[NOTE_BUFFER_SIZE];
static time_t s_note_epoch;
static bool s_send_in_flight;

static char s_status_text[128];

static void set_status(const char *text) {
  strncpy(s_status_text, text, sizeof(s_status_text) - 1);
  s_status_text[sizeof(s_status_text) - 1] = '\0';
  text_layer_set_text(s_status_layer, s_status_text);
}

static void persist_pending_note(void) {
  persist_write_string(PERSIST_KEY_PENDING_TEXT, s_note_text);
  persist_write_int(PERSIST_KEY_PENDING_EPOCH, (int32_t)s_note_epoch);
}

static void clear_pending_note(void) {
  persist_delete(PERSIST_KEY_PENDING_TEXT);
  persist_delete(PERSIST_KEY_PENDING_EPOCH);
}

static void send_note(void) {
  if (s_send_in_flight || s_note_text[0] == '\0') {
    return;
  }

  DictionaryIterator *out;
  AppMessageResult result = app_message_outbox_begin(&out);
  if (result != APP_MSG_OK) {
    set_status("Send failed.\nSaved on watch.");
    persist_pending_note();
    return;
  }

  dict_write_cstring(out, MESSAGE_KEY_NOTE_TEXT, s_note_text);
  dict_write_int32(out, MESSAGE_KEY_NOTE_EPOCH, (int32_t)s_note_epoch);
  dict_write_end(out);

  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    set_status("Send failed.\nSaved on watch.");
    persist_pending_note();
    return;
  }

  s_send_in_flight = true;
  set_status("Sending to phone...");
}

static void outbox_sent_handler(DictionaryIterator *iter, void *context) {
  // The companion received the note; it owns delivery from here
  // (including queueing while offline), so the watch copy can go.
  s_send_in_flight = false;
  clear_pending_note();
  set_status("Delivered to phone.\nUploading...");
}

static void outbox_failed_handler(DictionaryIterator *iter,
                                  AppMessageResult reason, void *context) {
  s_send_in_flight = false;
  persist_pending_note();
  set_status("Phone unreachable.\nSaved — will retry\non next launch.");
}

static void inbox_received_handler(DictionaryIterator *iter, void *context) {
  Tuple *code_t = dict_find(iter, MESSAGE_KEY_RESULT_CODE);
  Tuple *text_t = dict_find(iter, MESSAGE_KEY_RESULT_TEXT);
  Tuple *queue_t = dict_find(iter, MESSAGE_KEY_QUEUE_SIZE);

  if (!code_t) {
    return;
  }

  int32_t code = code_t->value->int32;
  const char *detail = text_t ? text_t->value->cstring : "";

  static char buf[128];
  switch (code) {
    case 0:
      snprintf(buf, sizeof(buf), "Note in your Index!");
      vibes_short_pulse();
      break;
    case 1:
      snprintf(buf, sizeof(buf), "Queued on phone (%d)\nwill upload when online",
               queue_t ? (int)queue_t->value->int32 : 1);
      break;
    case 2:
      snprintf(buf, sizeof(buf), "Not configured.\nOpen app settings\non your phone.");
      break;
    default:
      snprintf(buf, sizeof(buf), "Upload error:\n%s", detail);
      break;
  }
  set_status(buf);
}

static void dictation_callback(DictationSession *session,
                               DictationSessionStatus status,
                               char *transcription, void *context) {
  if (status == DictationSessionStatusSuccess) {
    strncpy(s_note_text, transcription, sizeof(s_note_text) - 1);
    s_note_text[sizeof(s_note_text) - 1] = '\0';
    s_note_epoch = time(NULL);
    send_note();
  } else {
    static char buf[64];
    snprintf(buf, sizeof(buf), "Dictation failed (%d)", (int)status);
    set_status(buf);
  }
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_dictation) {
    set_status("Listening...");
    dictation_session_start(s_dictation);
  } else {
    set_status("Dictation not\navailable on this\nwatch.");
  }
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
}

static void resend_pending_if_any(void) {
  if (persist_exists(PERSIST_KEY_PENDING_TEXT)) {
    persist_read_string(PERSIST_KEY_PENDING_TEXT, s_note_text,
                        sizeof(s_note_text));
    s_note_epoch = (time_t)persist_read_int(PERSIST_KEY_PENDING_EPOCH);
    if (s_note_text[0] != '\0') {
      set_status("Resending saved\nnote...");
      send_note();
    }
  }
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  const int16_t inset = PBL_IF_ROUND_ELSE(24, 8);

  s_title_layer = text_layer_create(
      GRect(inset, 10, bounds.size.w - 2 * inset, 30));
  text_layer_set_text(s_title_layer, "Index Notes");
  text_layer_set_font(s_title_layer,
                      fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_title_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_title_layer));

  s_status_layer = text_layer_create(
      GRect(inset, 45, bounds.size.w - 2 * inset, bounds.size.h - 90));
  text_layer_set_font(s_status_layer,
                      fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  set_status("Press SELECT and\nspeak your note.");
  layer_add_child(root, text_layer_get_layer(s_status_layer));

  s_hint_layer = text_layer_create(
      GRect(inset, bounds.size.h - 30, bounds.size.w - 2 * inset, 24));
  text_layer_set_text(s_hint_layer, "SELECT: new note");
  text_layer_set_font(s_hint_layer,
                      fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_hint_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_hint_layer));
}

static void window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_status_layer);
  text_layer_destroy(s_hint_layer);
}

static void init(void) {
  s_window = window_create();
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers){
      .load = window_load,
      .unload = window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(inbox_received_handler);
  app_message_register_outbox_sent(outbox_sent_handler);
  app_message_register_outbox_failed(outbox_failed_handler);
  app_message_open(256, NOTE_BUFFER_SIZE + 64);

  s_dictation = dictation_session_create(NOTE_BUFFER_SIZE,
                                         dictation_callback, NULL);
  if (s_dictation) {
    // Keep the confirmation screen so a mis-heard note can be retried
    // before it lands in the Index feed.
    dictation_session_enable_confirmation(s_dictation, true);
  }

  resend_pending_if_any();
}

static void deinit(void) {
  if (s_dictation) {
    dictation_session_destroy(s_dictation);
  }
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
