package com.zifang.teamviewer.common.interfaces;

import com.zifang.teamviewer.common.utils.Session;
import io.netty.util.AttributeKey;

public interface Attributes {
    AttributeKey<Boolean> LOGIN = AttributeKey.newInstance("login");
    AttributeKey<Session> SESSION = AttributeKey.newInstance("session");
}
