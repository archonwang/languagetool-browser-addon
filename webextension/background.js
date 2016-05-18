
function onClickHandler(info, tab) {
  if (chrome && chrome.browserAction && chrome.browserAction.openPopup) {
    // 'openPopup' is not documented at https://developer.chrome.com/extensions/browserAction,
    // and it's not in Chrome 50 (but in Chromium 49) so we are careful and don't call it if it's not there.
    // Also see https://bugs.chromium.org/p/chromium/issues/detail?id=436489
    chrome.browserAction.openPopup(
        function(popupView) {}
    );
  }
}

if (chrome && chrome.browserAction && chrome.browserAction.openPopup) {
  chrome.contextMenus.onClicked.addListener(onClickHandler);
  chrome.runtime.onInstalled.addListener(function() {
    chrome.contextMenus.create({"title": chrome.i18n.getMessage("contextMenuItem"), "contexts":["selection", "editable"], "id": "contextLT"});
    // With an entry only for 'editbale' we could have a better name, but then Chrome will
    // move both entries into a sub menu, which is very bad for usability, so 'editable' is covered
    // by the entry above instead:
    //chrome.contextMenus.create({"title": "Check text field", "contexts":["editable"], "id": "contextLTeditable"});
  });
}
