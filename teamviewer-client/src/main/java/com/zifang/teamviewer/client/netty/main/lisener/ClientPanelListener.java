package com.zifang.teamviewer.client.netty.main.lisener;

import java.awt.event.MouseEvent;
import java.awt.event.MouseListener;

public class ClientPanelListener implements MouseListener {

    public ClientPanelListener(){}
    public void mouseClicked(MouseEvent e) {
        System.out.println(e.getX());
        System.out.println(e.getY());
        System.out.println(e.getPoint());
    }

    public void mousePressed(MouseEvent e) {

    }

    public void mouseReleased(MouseEvent e) {

    }

    public void mouseEntered(MouseEvent e) {

    }

    public void mouseExited(MouseEvent e) {

    }
}
