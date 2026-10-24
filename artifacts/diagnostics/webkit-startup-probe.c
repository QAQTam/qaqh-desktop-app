/* Isolated WebKitGTK crash probe: no daemon, IPC, session data or app storage. */
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <stdlib.h>
#include <stdio.h>

static int result = 3;
static char *custom_script = NULL;
static gboolean finish(gpointer unused) { (void)unused; gtk_main_quit(); return G_SOURCE_REMOVE; }
static void terminated(WebKitWebView *view, WebKitWebProcessTerminationReason reason, gpointer unused) {
    (void)view; (void)unused;
    fprintf(stderr, "WEB_PROCESS_TERMINATED reason=%d\n", reason);
    result = 2;
    gtk_main_quit();
}
static void evaluated(GObject *view, GAsyncResult *async_result, gpointer unused) {
    (void)unused;
    GError *error = NULL;
    JSCValue *value = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(view), async_result, &error);
    if (error) { fprintf(stderr, "JS_ERROR: %s\n", error->message); g_error_free(error); return; }
    char *text = jsc_value_to_string(value);
    fprintf(stderr, "JS_RESULT: %s\n", text);
    g_free(text); g_object_unref(value);
    result = 0;
    g_timeout_add(800, finish, NULL);
}
static void loaded(WebKitWebView *view, WebKitLoadEvent event, gpointer transition) {
    if (event != WEBKIT_LOAD_FINISHED) return;
    const char *code = GPOINTER_TO_INT(transition)
        ? "document.startViewTransition(() => { document.body.textContent = 'after'; }); 'transition started'"
        : "document.body.textContent = 'after'; 'direct update'";
    webkit_web_view_evaluate_javascript(view, custom_script ? custom_script : code, -1, NULL, NULL, NULL, evaluated, NULL);
}
int main(int argc, char **argv) {
    int transition = argc > 1 ? atoi(argv[1]) : 1;
    int policy = argc > 2 ? atoi(argv[2]) : -1;
    if (argc > 3) {
        GError *error = NULL;
        if (!g_file_get_contents(argv[3], &custom_script, NULL, &error)) {
            fprintf(stderr, "SCRIPT_ERROR: %s\n", error->message);
            g_error_free(error);
            return 4;
        }
    }
    gtk_init(&argc, &argv);
    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_default_size(GTK_WINDOW(window), 400, 200);
    WebKitWebView *view = WEBKIT_WEB_VIEW(webkit_web_view_new_with_context(webkit_web_context_new_ephemeral()));
    if (policy >= 0) webkit_settings_set_hardware_acceleration_policy(webkit_web_view_get_settings(view), policy);
    fprintf(stderr, "PROBE transition=%d policy=%d effective_policy=%d\n", transition, policy,
        webkit_settings_get_hardware_acceleration_policy(webkit_web_view_get_settings(view)));
    g_signal_connect(view, "web-process-terminated", G_CALLBACK(terminated), NULL);
    g_signal_connect(view, "load-changed", G_CALLBACK(loaded), GINT_TO_POINTER(transition));
    gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(view));
    gtk_widget_show_all(window);
    webkit_web_view_load_html(view, "<!doctype html><html><body>before</body></html>", "https://probe.invalid/");
    g_timeout_add(5000, finish, NULL);
    gtk_main();
    fprintf(stderr, "PROBE_EXIT=%d\n", result);
    g_free(custom_script);
    return result;
}
